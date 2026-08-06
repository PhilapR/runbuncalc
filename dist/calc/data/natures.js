(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const util_1 = require("../util");
exports.NATURES = {
    Adamant: ['atk', 'spa'],
    Bashful: ['spa', 'spa'],
    Bold: ['def', 'atk'],
    Brave: ['atk', 'spe'],
    Calm: ['spd', 'atk'],
    Careful: ['spd', 'spa'],
    Docile: ['def', 'def'],
    Gentle: ['spd', 'def'],
    Hardy: ['atk', 'atk'],
    Hasty: ['spe', 'def'],
    Impish: ['def', 'spa'],
    Jolly: ['spe', 'spa'],
    Lax: ['def', 'spd'],
    Lonely: ['atk', 'def'],
    Mild: ['spa', 'def'],
    Modest: ['spa', 'atk'],
    Naive: ['spe', 'spd'],
    Naughty: ['atk', 'spd'],
    Quiet: ['spa', 'spe'],
    Quirky: ['spd', 'spd'],
    Rash: ['spa', 'spd'],
    Relaxed: ['def', 'spe'],
    Sassy: ['spd', 'spe'],
    Serious: ['spe', 'spe'],
    Timid: ['spe', 'atk'],
};
class Natures {
    get(id) {
        return NATURES_BY_ID[id];
    }
    *[Symbol.iterator]() {
        for (const id in NATURES_BY_ID) {
            yield this.get(id);
        }
    }
}
exports.Natures = Natures;
class Nature {
    constructor(name, [plus, minus]) {
        this.kind = 'Nature';
        this.id = (0, util_1.toID)(name);
        this.name = name;
        this.plus = plus;
        this.minus = minus;
    }
}
const NATURES_BY_ID = {};
for (const nature in exports.NATURES) {
    const n = new Nature(nature, exports.NATURES[nature]);
    NATURES_BY_ID[n.id] = n;
}
//# sourceMappingURL=natures.js.map
})();
