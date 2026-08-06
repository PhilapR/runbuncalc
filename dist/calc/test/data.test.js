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
const adaptable_1 = require("../adaptable");
const calc = __importStar(require("../index"));
const dex_1 = require("@pkmn/dex");
const gen_1 = require("./gen");
const pkmn = { Generations: new gen_1.Generations(dex_1.Dex) };
const gens = [1, 2, 3, 4, 5, 6, 7, 8, 9];
describe('Generations', () => {
    test('abilities', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).abilities);
            const c = new Map();
            for (const ability of calc.Generations.get(gen).abilities)
                c.set(ability.id, ability);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const ability of p) {
                expect(c.get(ability.id)).toEqual(ability);
                c.delete(ability.id);
            }
            expect(c.size).toBe(0);
        }
    });
    test('items', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).items);
            const c = new Map();
            for (const item of calc.Generations.get(gen).items)
                c.set(item.id, item);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const item of p) {
                expect(c.get(item.id)).toEqual(item);
                c.delete(item.id);
            }
            expect(c.size).toBe(0);
        }
    });
    test('moves', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).moves);
            const c = new Map();
            for (const move of calc.Generations.get(gen).moves)
                c.set(move.id, move);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const move of p) {
                for (const [k, v] of Object.entries(move)) {
                    if (v === undefined) {
                        delete move[k];
                    }
                }
                expect(c.get(move.id)).toMatchObject(move);
                c.delete(move.id);
            }
            expect(c.size).toBe(0);
        }
    });
    test('species', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).species);
            const c = new Map();
            for (const specie of calc.Generations.get(gen).species)
                c.set(specie.id, specie);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const specie of p) {
                expect(c.get(specie.id)).toEqual(specie);
                c.delete(specie.id);
            }
            expect(c.size).toBe(0);
        }
    });
    test('types', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).types);
            const c = new Map();
            for (const type of calc.Generations.get(gen).types)
                c.set(type.id, type);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const type of p) {
                expect(c.get(type.id)).toEqual(type);
                c.delete(type.id);
            }
            expect(c.size).toBe(0);
        }
    });
    test('natures', () => {
        for (const gen of gens) {
            const p = Array.from(pkmn.Generations.get(gen).natures);
            const c = new Map();
            for (const nature of calc.Generations.get(gen).natures)
                c.set(nature.id, nature);
            expect(Array.from(c.values()).map(s => s.name).sort()).toEqual(p.map(s => s.name).sort());
            for (const nature of p) {
                expect(c.get(nature.id)).toEqual(nature);
                c.delete(nature.id);
            }
            expect(c.size).toBe(0);
        }
    });
});
describe('Adaptable', () => {
    test('usage', () => {
        const gen = pkmn.Generations.get(5);
        const result = (0, adaptable_1.calculate)(gen, new adaptable_1.Pokemon(gen, 'Gengar', {
            item: 'Choice Specs',
            nature: 'Timid',
            evs: { spa: 252 },
            boosts: { spa: 1 },
        }), new adaptable_1.Pokemon(gen, 'Chansey', {
            item: 'Eviolite',
            nature: 'Calm',
            evs: { hp: 252, spd: 252 },
        }), new adaptable_1.Move(gen, 'Focus Blast'));
        expect(result.range()).toEqual([274, 324]);
    });
});
//# sourceMappingURL=data.test.js.map