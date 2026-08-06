(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

exports.damageRange = damageRange;
const desc_1 = require("./desc");
class Result {
    constructor(gen, attacker, defender, move, field, damage, rawDesc) {
        this.gen = gen;
        this.attacker = attacker;
        this.defender = defender;
        this.move = move;
        this.field = field;
        this.damage = damage;
        this.rawDesc = rawDesc;
    }
    desc() {
        return this.fullDesc();
    }
    range() {
        const range = damageRange(this.damage);
        if (typeof range[0] === 'number')
            return range;
        const d = range;
        return [d[0][0] + d[0][1], d[1][0] + d[1][1]];
    }
    fullDesc(notation = '%', err = true) {
        return (0, desc_1.display)(this.gen, this.attacker, this.defender, this.move, this.field, this.damage, this.rawDesc, notation, err);
    }
    moveDesc(notation = '%') {
        return (0, desc_1.displayMove)(this.gen, this.attacker, this.defender, this.move, this.damage, notation);
    }
    recovery(notation = '%') {
        return (0, desc_1.getRecovery)(this.gen, this.attacker, this.defender, this.move, this.damage, notation);
    }
    recoil(notation = '%') {
        return (0, desc_1.getRecoil)(this.gen, this.attacker, this.defender, this.move, this.damage, notation);
    }
    kochance(err = true) {
        return (0, desc_1.getKOChance)(this.gen, this.attacker, this.defender, this.move, this.field, this.damage, err);
    }
}
exports.Result = Result;
function damageRange(damage) {
    if (typeof damage === 'number')
        return [damage, damage];
    if (damage.length > 2) {
        const d = damage;
        if (d[0] > d[d.length - 1])
            return [Math.min(...d), Math.max(...d)];
        return [d[0], d[d.length - 1]];
    }
    if (typeof damage[0] === 'number' && typeof damage[1] === 'number') {
        return [[damage[0], damage[1]], [damage[0], damage[1]]];
    }
    const d = damage;
    if (d[0][0] > d[0][d[0].length - 1])
        d[0] = d[0].slice().sort();
    if (d[1][0] > d[1][d[1].length - 1])
        d[1] = d[1].slice().sort();
    return [[d[0][0], d[1][0]], [d[0][d[0].length - 1], d[1][d[1].length - 1]]];
}
//# sourceMappingURL=result.js.map
})();
