/* eslint-env jest */

import {inGens} from './helper';

describe('calculator mechanics regressions', () => {
  inGens(2, 2, ({calculate, Pokemon, Move}) => {
    test('keeps Gen II damage at a minimum of one after the random factor', () => {
      const result = calculate(
        Pokemon('Magikarp', {level: 5}),
        Pokemon('Shuckle', {level: 100}),
        Move('Tackle', {overrides: {basePower: 1}}),
      );

      expect(Math.min(...(result.damage as number[]))).toBe(1);
    });
  });

  inGens(7, 7, ({calculate, Pokemon, Move}) => {
    test('exposes exact HP for proportional recoil without changing display recoil', () => {
      const attacker = Pokemon('Abomasnow', {
        item: 'Icy Rock',
        ability: 'Snow Warning',
        nature: 'Hasty',
        evs: {atk: 252, spd: 4, spe: 252},
      });
      const defender = Pokemon('Hoopa-Unbound', {
        item: 'Choice Band',
        ability: 'Magician',
        nature: 'Jolly',
        evs: {hp: 32, atk: 224, spe: 252},
      });
      const result = calculate(attacker, defender, Move('Wood Hammer'));

      expect(result.recoil()).toMatchObject({recoil: [24, 28.3], text: '24 - 28.3% recoil damage'});
      expect(result.recoil().recoilHP).toEqual([77, 91]);
    });
  });

  inGens(7, 9, ({calculate, Pokemon, Move}) => {
    test('applies Triage priority to healing moves, not ordinary moves', () => {
      const attacker = Pokemon('Mew', {ability: 'Triage'});
      const defender = Pokemon('Vulpix');

      expect(calculate(attacker, defender, Move('Recover')).move.priority).toBe(1);
      expect(calculate(attacker, defender, Move('Drain Punch')).move.priority).toBe(1);
      expect(calculate(attacker, defender, Move('Tackle')).move.priority).toBe(0);

      const galeWings = Pokemon('Mew', {ability: 'Gale Wings'});
      expect(calculate(galeWings, defender, Move('Tailwind')).move.priority).toBe(1);
    });
  });

  inGens(5, 9, ({calculate, Pokemon, Move, Field}) => {
    test('quarters the affected side speed under Pledge swamp', () => {
      const attacker = Pokemon('Mew');
      const defender = Pokemon('Mew');
      const normal = calculate(attacker, defender, Move('Tackle'), Field({gameType: 'Doubles'}));
      const swamp = calculate(attacker, defender, Move('Tackle'), Field({
        gameType: 'Doubles',
        defenderSide: {isPledgeSwamp: true},
      }));
      expect(swamp.defender.stats.spe).toBe(Math.floor(normal.defender.stats.spe / 4));
    });

    test('gives a combined Pledge move forced STAB', () => {
      const attacker = Pokemon('Pikachu');
      const defender = Pokemon('Mew');
      const unboosted = calculate(attacker, defender, Move('Water Pledge', {
        overrides: {basePower: 150},
      }));
      const combined = calculate(attacker, defender, Move('Water Pledge', {
        forceSTAB: true,
        overrides: {basePower: 150},
      }));
      expect(Math.max(...(combined.damage as number[]))).toBeGreaterThan(
        Math.max(...(unboosted.damage as number[])),
      );
    });
  });

  inGens(8, 9, ({calculate, Pokemon, Move}) => {
    test('preserves suppressed held-item presence for Poltergeist', () => {
      const attacker = Pokemon('Gengar');
      const activeItem = Pokemon('Pikachu', {item: 'Leftovers'});
      const suppressedItem = Pokemon('Pikachu', {item: 'Leftovers', itemSuppressed: true});

      const activeResult = calculate(attacker, activeItem, Move('Poltergeist'));
      const suppressedResult = calculate(attacker, suppressedItem, Move('Poltergeist'));

      expect(activeResult.damage).toEqual(suppressedResult.damage);
    });
  });
});
