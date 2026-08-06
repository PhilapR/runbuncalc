(function () {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculate = calculate;
const field_1 = require("./field");
const gen12_1 = require("./mechanics/gen12");
const gen3_1 = require("./mechanics/gen3");
const gen4_1 = require("./mechanics/gen4");
const gen56_1 = require("./mechanics/gen56");
const gen789_1 = require("./mechanics/gen789");
const MECHANICS = [
    () => { },
    gen12_1.calculateRBYGSC,
    gen12_1.calculateRBYGSC,
    gen3_1.calculateADV,
    gen4_1.calculateDPP,
    gen56_1.calculateBWXY,
    gen56_1.calculateBWXY,
    gen789_1.calculateSMSSSV,
    gen789_1.calculateSMSSSV,
    gen789_1.calculateSMSSSV,
];
function calculate(gen, attacker, defender, move, field) {
    return MECHANICS[gen.num](gen, attacker.clone(), defender.clone(), move.clone(), field ? field.clone() : new field_1.Field());
}
//# sourceMappingURL=calc.js.map
})();
