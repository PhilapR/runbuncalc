/* eslint-env jest */

import {inGen, inGens} from './helper';

describe('Run & Bun fork behavior', () => {
  inGen(8, ({calculate, Pokemon, Move, Field}) => {
    test('uses the fork move data for Super Fang', () => {
      expect(Move('Super Fang').type).toBe('Dark');
    });

    // The calculator and the AI overlay must agree on this base power, or the
    // browser calc and the AI score the same move differently. See
    // `ai/src/move-metadata.ts` (CUSTOM_BASE_POWER) and `runbun-data.test.ts`.
    test('uses the fork base power for Misty Explosion', () => {
      expect(Move('Misty Explosion').bp).toBe(200);
    });

    test('uses IVs in damage descriptions', () => {
      const result = calculate(Pokemon('Mew'), Pokemon('Vulpix'), Move('Tackle'));
      expect(result.desc()).toContain('31 Atk Mew Tackle vs. 31 HP / 31 Def Vulpix');
    });

    test('applies the fork terrain damage boost in modern generations', () => {
      const result = calculate(
        Pokemon('Mewtwo', {nature: 'Timid', evs: {spa: 252}, boosts: {spa: 2}}),
        Pokemon('Milotic', {
          item: 'Flame Orb',
          nature: 'Bold',
          ability: 'Marvel Scale',
          evs: {hp: 248, def: 184},
          status: 'brn',
          boosts: {spd: 1},
        }),
        Move('Psystrike'),
        Field({terrain: 'Psychic'})
      );

      expect(result.range()).toEqual([331, 391]);
    });

    test('keeps Gale Wings priority when the attacker is not at full HP', () => {
      const result = calculate(
        Pokemon('Mew', {ability: 'Gale Wings', originalCurHP: 1}),
        Pokemon('Vulpix'),
        Move('Air Slash'),
      );

      expect(result.move.priority).toBe(1);
    });

    test('models the fork Disguise first-hit protection when explicitly intact', () => {
      const result = calculate(
        Pokemon('Mew'),
        Pokemon('Mimikyu', {ability: 'Disguise', disguiseBroken: false}),
        Move('Tackle'),
      );

      expect(result.range()).toEqual([0, 0]);
    });

    test('models Soul Dew as SpA and SpD stages for Latias and Latios', () => {
      const latios = Pokemon('Latios', {item: 'Soul Dew', boosts: {spa: 5, spd: -1}});
      expect(latios.boosts.spa).toBe(6);
      expect(latios.boosts.spd).toBe(0);
      expect(Pokemon('Latias', {item: 'Soul Dew'}).clone().boosts.spa).toBe(1);
      const result = calculate(latios, Pokemon('Vulpix'), Move('Psychic'));
      expect(result.rawDesc.attackBoost).toBe(6);
    });

    test('preserves explicit type overrides through calculator cloning', () => {
      const roosted = Pokemon('Pidgey', {overrides: {types: ['Normal']}});
      expect(roosted.types).toEqual(['Normal']);
      expect(roosted.clone().types).toEqual(['Normal']);
      const result = calculate(Pokemon('Pikachu'), roosted, Move('Earthquake'));
      expect(result.range()).not.toEqual([0, 0]);
    });

    test('preserves explicit raw stat overrides through calculator cloning', () => {
      const swapped = Pokemon('Shuckle', {statOverrides: {atk: 496, def: 56}});
      expect(swapped.clone().rawStats.atk).toBe(496);
      expect(swapped.clone().rawStats.def).toBe(56);
      const result = calculate(swapped, Pokemon('Pikachu'), Move('Earthquake'));
      expect(result.attacker.rawStats.atk).toBe(496);
      expect(result.attacker.rawStats.def).toBe(56);
    });

    test('does not create a Parental Bond child hit while the ability is off', () => {
      const active = calculate(
        Pokemon('Kangaskhan', {ability: 'Parental Bond', abilityOn: true}),
        Pokemon('Vulpix'), Move('Tackle'),
      );
      const suppressed = calculate(
        Pokemon('Kangaskhan', {ability: 'Parental Bond', abilityOn: false}),
        Pokemon('Vulpix'), Move('Tackle'),
      );
      expect(active.range()[0]).toBeGreaterThan(suppressed.range()[0]);
      expect(suppressed.rawDesc.attackerAbility).toBeUndefined();
    });
  });

  inGen(9, ({Pokemon}) => {
    test('uses the fork Azumarill base Attack data', () => {
      expect(Pokemon('Azumarill').species.baseStats.atk).toBe(65);
    });
  });

  inGens(3, 8, ({calculate, Pokemon, Move}) => {
    test('honors explicit grounding overrides for Ground-type damage', () => {
      const airborne = calculate(
        Pokemon('Pikachu'),
        Pokemon('Rattata', {isGrounded: false}),
        Move('Earthquake'),
      );
      const grounded = calculate(
        Pokemon('Pikachu'),
        Pokemon('Rattata', {isGrounded: true}),
        Move('Earthquake'),
      );
      expect(airborne.range()).toEqual([0, 0]);
      expect(grounded.range()).not.toEqual([0, 0]);
    });

    test('uses the fork critical-hit prevention for Magma Armor', () => {
      const result = calculate(
        Pokemon('Mew'),
        Pokemon('Vulpix', {ability: 'Magma Armor'}),
        Move('Slash', {isCrit: true}),
      );

      expect(result.rawDesc.isCritical).toBeFalsy();
    });

    test('uses the fork 1.5x critical-hit damage multiplier', () => {
      const critical = calculate(
        Pokemon('Mew'),
        Pokemon('Vulpix'),
        Move('Slash', {isCrit: true}),
      );
      const normal = calculate(
        Pokemon('Mew'),
        Pokemon('Vulpix'),
        Move('Slash'),
      );
      expect(normal.range()).toEqual([102, 121]);
      expect(critical.range()).toEqual([153, 181]);
      expect(critical.rawDesc.isCritical).toBeTruthy();
    });
  });

  inGens(1, 2, ({calculate, Pokemon, Move}) => {
    test('uses the fork 1.5x critical-hit damage multiplier in legacy generations', () => {
      const critical = calculate(
        Pokemon('Mew'),
        Pokemon('Vulpix'),
        Move('Tackle', {isCrit: true}),
      );
      const normal = calculate(Pokemon('Mew'), Pokemon('Vulpix'), Move('Tackle'));

      expect(critical.rawDesc.isCritical).toBeTruthy();
      expect(critical.range()[0]).toBeGreaterThanOrEqual(Math.floor(normal.range()[0] * 1.4));
      expect(critical.range()[0]).toBeLessThan(Math.floor(normal.range()[0] * 1.7));
    });
  });

  inGens(4, 8, ({calculate, Pokemon, Move, Field}) => {
    test('Lucky Chant prevents forced critical hits', () => {
      const luckyChant = calculate(
        Pokemon('Mew'),
        Pokemon('Vulpix'),
        Move('Slash', {isCrit: true}),
        Field({defenderSide: {isLuckyChant: true}}),
      );
      const normal = calculate(Pokemon('Mew'), Pokemon('Vulpix'), Move('Slash'));
      expect(luckyChant.rawDesc.isCritical).toBeFalsy();
      expect(luckyChant.range()).toEqual(normal.range());
    });
  });

  inGens(5, 8, ({calculate, Pokemon, Move}) => {
    test('allows Ground damage against a landed Flying target', () => {
      const landedFlying = calculate(
        Pokemon('Pikachu'),
        Pokemon('Pidgey', {isGrounded: true}),
        Move('Earthquake'),
      );
      expect(landedFlying.range()).not.toEqual([0, 0]);
    });
  });

  inGens(5, 9, ({calculate, Pokemon, Move}) => {
    test('uses the fork Iron Ball grounding behavior', () => {
      const result = calculate(
        Pokemon('Vibrava'),
        Pokemon('Zapdos', {item: 'Iron Ball'}),
        Move('Earthquake'),
      );
      expect(result.range()).toEqual([186, 218]);
    });
  });

  inGens(3, 7, ({calculate, Pokemon, Move, Field}) => {
    test('applies Water Sport and Mud Sport field power reductions', () => {
      const fire = calculate(Pokemon('Mew'), Pokemon('Rattata'), Move('Flamethrower'));
      const fireReduced = calculate(
        Pokemon('Mew'), Pokemon('Rattata'), Move('Flamethrower'), Field({isWaterSport: true}),
      );
      const electric = calculate(Pokemon('Mew'), Pokemon('Rattata'), Move('Thunderbolt'));
      const electricReduced = calculate(
        Pokemon('Mew'), Pokemon('Rattata'), Move('Thunderbolt'), Field({isMudSport: true}),
      );
      expect(fireReduced.range()[1]).toBeLessThan(fire.range()[1]);
      expect(electricReduced.range()[1]).toBeLessThan(electric.range()[1]);
    });
  });

  inGen(8, ({calculate, Pokemon, Move, Field}) => {
    test('does not apply unavailable Water Sport or Mud Sport in Gen 8', () => {
      const fire = calculate(Pokemon('Mew'), Pokemon('Rattata'), Move('Flamethrower'));
      const fireWithWaterSport = calculate(
        Pokemon('Mew'), Pokemon('Rattata'), Move('Flamethrower'), Field({isWaterSport: true}),
      );
      expect(fireWithWaterSport.range()).toEqual(fire.range());
    });
  });

  inGens(6, 7, ({calculate, Pokemon, Move, Field}) => {
    test('Ion Deluge converts Normal moves to Electric', () => {
      const normal = calculate(Pokemon('Mew'), Pokemon('Pidgey'), Move('Tackle'));
      const ion = calculate(
        Pokemon('Mew'), Pokemon('Pidgey'), Move('Tackle'), Field({isIonDeluge: true}),
      );
      expect(ion.rawDesc.moveType).toBe('Electric');
      expect(ion.range()[0]).toBeGreaterThan(normal.range()[1]);
    });
  });

  inGen(5, ({calculate, Pokemon, Move, Field}) => {
    test('Ion Deluge is not active before Generation VI', () => {
      const normal = calculate(Pokemon('Mew'), Pokemon('Pidgey'), Move('Tackle'));
      const ion = calculate(
        Pokemon('Mew'), Pokemon('Pidgey'), Move('Tackle'), Field({isIonDeluge: true}),
      );
      expect(ion.range()).toEqual(normal.range());
    });
  });
});
