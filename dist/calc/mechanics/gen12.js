(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateRBYGSC = calculateRBYGSC;
const items_1 = require("../items");
const result_1 = require("../result");
const util_1 = require("./util");
function calculateRBYGSC(gen, attacker, defender, move, field) {
    (0, util_1.computeFinalStats)(gen, attacker, defender, field, 'atk', 'def', 'spa', 'spd', 'spe');
    const desc = {
        attackerName: attacker.name,
        moveName: move.name,
        defenderName: defender.name,
    };
    const result = new result_1.Result(gen, attacker, defender, move, field, 0, desc);
    if (move.category === 'Status') {
        return result;
    }
    if (field.defenderSide.isProtected) {
        desc.isProtected = true;
        return result;
    }
    if (gen.num === 1) {
        const fixedDamage = (0, util_1.handleFixedDamageMoves)(attacker, move, defender);
        if (fixedDamage) {
            result.damage = fixedDamage;
            return result;
        }
    }
    const type1Effectiveness = (0, util_1.getMoveEffectiveness)(gen, move, defender.types[0], field.defenderSide.isForesight, undefined, undefined, field.defenderSide.isMiracleEye);
    const type2Effectiveness = defender.types[1]
        ? (0, util_1.getMoveEffectiveness)(gen, move, defender.types[1], field.defenderSide.isForesight, undefined, undefined, field.defenderSide.isMiracleEye)
        : 1;
    const typeEffectiveness = type1Effectiveness * type2Effectiveness;
    if (typeEffectiveness === 0) {
        return result;
    }
    if (gen.num === 2) {
        const fixedDamage = (0, util_1.handleFixedDamageMoves)(attacker, move, defender);
        if (fixedDamage) {
            result.damage = fixedDamage;
            return result;
        }
    }
    if (move.hits > 1) {
        desc.hits = move.hits;
    }
    if (move.named('Flail', 'Reversal')) {
        move.isCrit = false;
        const p = Math.floor((48 * attacker.curHP()) / attacker.maxHP());
        move.bp = p <= 1 ? 200 : p <= 4 ? 150 : p <= 9 ? 100 : p <= 16 ? 80 : p <= 32 ? 40 : 20;
        desc.moveBP = move.bp;
    }
    else if (move.named('Present') && !move.bp) {
        move.bp = 40;
    }
    if (move.bp === 0) {
        return result;
    }
    const isPhysical = move.category === 'Physical';
    const attackStat = isPhysical ? 'atk' : 'spa';
    const defenseStat = isPhysical ? 'def' : 'spd';
    let at = attacker.stats[attackStat];
    let df = defender.stats[defenseStat];
    const ignoreMods = move.isCrit &&
        (gen.num === 1 ||
            (gen.num === 2 && attacker.boosts[attackStat] <= defender.boosts[defenseStat]));
    let lv = attacker.level;
    if (ignoreMods) {
        at = attacker.rawStats[attackStat];
        df = defender.rawStats[defenseStat];
    }
    else {
        if (attacker.boosts[attackStat] !== 0)
            desc.attackBoost = attacker.boosts[attackStat];
        if (defender.boosts[defenseStat] !== 0)
            desc.defenseBoost = defender.boosts[defenseStat];
        if (isPhysical && attacker.hasStatus('brn')) {
            at = Math.floor(at / 2);
            desc.isBurned = true;
        }
    }
    if (move.named('Explosion', 'Self-Destruct')) {
        df = Math.floor(df / 2);
    }
    if (!ignoreMods) {
        if (isPhysical && field.defenderSide.isReflect) {
            df *= 2;
            desc.isReflect = true;
        }
        else if (!isPhysical && field.defenderSide.isLightScreen) {
            df *= 2;
            desc.isLightScreen = true;
        }
    }
    if ((attacker.named('Pikachu') && attacker.hasItem('Light Ball') && !isPhysical) ||
        (attacker.named('Cubone', 'Marowak') && attacker.hasItem('Thick Club') && isPhysical)) {
        at *= 2;
        desc.attackerItem = attacker.item;
    }
    if (at > 255 || df > 255) {
        at = Math.floor(at / 4) % 256;
        df = Math.floor(df / 4) % 256;
    }
    if (move.named('Present')) {
        const lookup = {
            Normal: 0, Fighting: 1, Flying: 2, Poison: 3, Ground: 4, Rock: 5, Bug: 7,
            Ghost: 8, Steel: 9, '???': 19, Fire: 20, Water: 21, Grass: 22, Electric: 23,
            Psychic: 24, Ice: 25, Dragon: 26, Dark: 27,
        };
        at = 10;
        df = Math.max(lookup[attacker.types[1] ? attacker.types[1] : attacker.types[0]], 1);
        lv = Math.max(lookup[defender.types[1] ? defender.types[1] : defender.types[0]], 1);
    }
    if (defender.named('Ditto') && defender.hasItem('Metal Powder')) {
        df = Math.floor(df * 1.5);
        desc.defenderItem = defender.item;
    }
    let baseDamage = Math.floor(Math.floor((Math.floor((2 * lv) / 5 + 2) * Math.max(1, at) * move.bp) / Math.max(1, df)) / 50);
    if (move.isCrit) {
        baseDamage = Math.floor(baseDamage * 1.5);
        desc.isCritical = true;
    }
    if (move.named('Pursuit') && field.defenderSide.isSwitching === 'out') {
        baseDamage = Math.floor(baseDamage * 2);
        desc.isSwitching = 'out';
    }
    const itemBoostType = attacker.hasItem('Dragon Fang')
        ? undefined
        : (0, items_1.getItemBoostType)(attacker.hasItem('Dragon Scale') ? 'Dragon Fang' : attacker.item);
    if (move.hasType(itemBoostType)) {
        baseDamage = Math.floor(baseDamage * 1.1);
        desc.attackerItem = attacker.item;
    }
    baseDamage = Math.min(997, baseDamage) + 2;
    if ((field.hasWeather('Sun') && move.hasType('Fire')) ||
        (field.hasWeather('Rain') && move.hasType('Water'))) {
        baseDamage = Math.floor(baseDamage * 1.5);
        desc.weather = field.weather;
    }
    else if ((field.hasWeather('Sun') && move.hasType('Water')) ||
        (field.hasWeather('Rain') && (move.hasType('Fire') || move.named('Solar Beam')))) {
        baseDamage = Math.floor(baseDamage / 2);
        desc.weather = field.weather;
    }
    if (move.hasType(...attacker.types)) {
        baseDamage = Math.floor(baseDamage * 1.5);
    }
    if (gen.num === 1) {
        baseDamage = Math.floor(baseDamage * type1Effectiveness);
        baseDamage = Math.floor(baseDamage * type2Effectiveness);
    }
    else {
        baseDamage = Math.floor(baseDamage * typeEffectiveness);
    }
    if (move.named('Flail', 'Reversal')) {
        result.damage = baseDamage;
        return result;
    }
    result.damage = [];
    for (let i = 217; i <= 255; i++) {
        if (gen.num === 2) {
            result.damage[i - 217] = Math.max(1, Math.floor((baseDamage * i) / 255));
        }
        else {
            if (baseDamage === 1) {
                result.damage[i - 217] = 1;
            }
            else {
                result.damage[i - 217] = Math.floor((baseDamage * i) / 255);
            }
        }
    }
    return result;
}
//# sourceMappingURL=gen12.js.map
})();
