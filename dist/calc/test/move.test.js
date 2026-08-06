"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../index");
describe('Move', () => {
    test('clone', () => {
        const m = new index_1.Move(7, 'Blizzard', { useZ: true });
        expect(m.name).toBe('Subzero Slammer');
        expect(m.bp).toBe(185);
        const clone = m.clone();
        expect(clone.name).toBe('Subzero Slammer');
        expect(clone.bp).toBe(185);
    });
});
//# sourceMappingURL=move.test.js.map