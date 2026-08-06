"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inGen = inGen;
exports.inGens = inGens;
exports.tests = tests;
const index_1 = require("../index");
const field_1 = require("../field");
const calc = (gen) => (attacker, defender, move, field) => (0, index_1.calculate)(gen, attacker, defender, move, field);
const move = (gen) => (name, options = {}) => new index_1.Move(gen, name, options);
const pokemon = (gen) => (name, options = {}) => new index_1.Pokemon(gen, name, options);
const field = (field = {}) => new field_1.Field(field);
const side = (side = {}) => new field_1.Side(side);
function inGen(gen, fn) {
    fn({
        gen,
        calculate: calc(gen),
        Move: move(gen),
        Pokemon: pokemon(gen),
        Field: field,
        Side: side,
    });
}
function inGens(from, to, fn) {
    for (let gen = from; gen <= to; gen++) {
        inGen(gen, fn);
    }
}
function tests(...args) {
    var _a, _b, _c;
    const name = args[0];
    let from;
    let to;
    let fn;
    let type = undefined;
    if (typeof args[1] !== 'number') {
        from = 1;
        to = 8;
        fn = args[1];
        type = args[2];
    }
    else if (typeof args[2] !== 'number') {
        from = (_a = args[1]) !== null && _a !== void 0 ? _a : 1;
        to = 8;
        fn = args[2];
        type = args[3];
    }
    else {
        from = (_b = args[1]) !== null && _b !== void 0 ? _b : 1;
        to = (_c = args[2]) !== null && _c !== void 0 ? _c : 8;
        fn = args[3];
        type = args[4];
    }
    inGens(from, to, gen => {
        const n = `${name} (gen ${gen.gen})`;
        if (type === 'skip') {
            test.skip(n, () => fn(gen));
        }
        else if (type === 'only') {
            test.only(n, () => fn(gen));
        }
        else {
            test(n, () => fn(gen));
        }
    });
}
expect.extend({
    toMatch(received, gen, notation, diff) {
        if (typeof notation !== 'string') {
            diff = notation;
            notation = '%';
        }
        if (!diff)
            throw new Error('toMatch called with no diff!');
        const breakdowns = Object.entries(diff).sort();
        const expected = { range: undefined, desc: '', result: '' };
        for (const [g, { range, desc, result }] of breakdowns) {
            if (Number(g) > gen)
                break;
            if (range)
                expected.range = range;
            if (desc)
                expected.desc = desc;
            if (result)
                expected.result = result;
        }
        if (!(expected.range || expected.desc || expected.result)) {
            throw new Error(`toMatch called with empty diff: ${diff}`);
        }
        if (expected.range) {
            if (this.isNot) {
                expect(received.range()).not.toEqual(expected.range);
            }
            else {
                expect(received.range()).toEqual(expected.range);
            }
        }
        if (expected.desc) {
            const r = received.fullDesc(notation).split(': ')[0];
            if (this.isNot) {
                expect(r).not.toEqual(expected.desc);
            }
            else {
                expect(r).toEqual(expected.desc);
            }
        }
        if (expected.result) {
            const post = received.fullDesc(notation).split(': ')[1];
            const r = `(${post.split('(')[1]}`;
            if (this.isNot) {
                expect(r).not.toEqual(expected.result);
            }
            else {
                expect(r).toEqual(expected.result);
            }
        }
        return { pass: !this.isNot, message: () => '' };
    },
});
//# sourceMappingURL=helper.js.map