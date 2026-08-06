(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const abilities_1 = require("./abilities");
const items_1 = require("./items");
const moves_1 = require("./moves");
const species_1 = require("./species");
const types_1 = require("./types");
const natures_1 = require("./natures");
exports.Generations = new (class {
    get(gen) {
        return new Generation(gen);
    }
})();
class Generation {
    constructor(num) {
        this.num = num;
        this.abilities = new abilities_1.Abilities(num);
        this.items = new items_1.Items(num);
        this.moves = new moves_1.Moves(num);
        this.species = new species_1.Species(num);
        this.types = new types_1.Types(num);
        this.natures = new natures_1.Natures();
    }
}
//# sourceMappingURL=index.js.map
})();
