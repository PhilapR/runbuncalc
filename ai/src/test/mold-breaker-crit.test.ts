import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {BattleState} from '../model';
import {deriveMoveResolution} from '../move-engine';

// Battle Armor and Shell Armor are breakable abilities: a Mold Breaker
// attacker ignores them and can land a critical hit (Showdown
// data/abilities.ts: battlearmor/shellarmor carry flags {breakable: 1}; the
// calculator blanks the defender ability for Mold Breaker before its crit
// check in calc/src/mechanics/gen789.ts). The crit gate in calc-adapter
// checked the defender's ability without asking whether the attacker
// ignores it, so a Mold Breaker attacker never critted an armored target.
function state(attackerAbility: string, defenderAbility: string): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Excadrill', level: 50, ability: attackerAbility, abilityOn: true,
        hp: {current: 150, max: 150}, moves: [{name: 'Iron Head'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Kabutops', level: 50, ability: defenderAbility, abilityOn: true,
        hp: {current: 300, max: 300}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

const action = {kind: 'move' as const, actorId: 'ai-1', moveName: 'Iron Head', targetIds: ['player-1']};

// Without Mold Breaker, Battle Armor blocks the crit: no crit band at all.
{
  const fixture = state('Sand Rush', 'Battle Armor');
  const facts = calculateActionFacts(fixture, action);
  assert.equal(facts.damage?.critRolls, undefined, 'Battle Armor blocks crits from an ordinary attacker');
}

// With Mold Breaker the crit band exists, is bigger than the normal hit, and
// a crit draw lands it.
{
  const fixture = state('Mold Breaker', 'Battle Armor');
  const facts = calculateActionFacts(fixture, action);
  assert.ok(facts.damage?.critRolls?.length, 'Mold Breaker ignores Battle Armor: a crit is possible');
  assert.ok(facts.damage!.critMax! > facts.damage!.max, 'the crit band is the 1.5x band');
  // Every draw 0: the move hits, the crit draw (< 1/16) crits, and the
  // lowest crit roll is taken.
  const resolution = deriveMoveResolution(fixture, action, {facts, random: () => 0});
  assert.deepEqual(resolution.criticalHitTargets, ['player-1']);
  assert.equal(resolution.damageByTarget?.['player-1'], facts.damage!.critRolls![0]);
}

// Shell Armor is the same rule.
{
  const fixture = state('Mold Breaker', 'Shell Armor');
  assert.ok(calculateActionFacts(fixture, action).damage?.critRolls?.length,
    'Mold Breaker ignores Shell Armor too');
}

// isHighCrit (the AI doc's "high crit chance" clause) agrees: Laser Focus
// against a Battle Armor target counts only when Mold Breaker breaks it.
{
  const blocked = state('Sand Rush', 'Battle Armor');
  blocked.sides.ai.party[0].volatile = {laserFocus: {turns: 1}};
  assert.equal(calculateActionFacts(blocked, action).isHighCrit, false);
  const broken = state('Mold Breaker', 'Battle Armor');
  broken.sides.ai.party[0].volatile = {laserFocus: {turns: 1}};
  assert.equal(calculateActionFacts(broken, action).isHighCrit, true);
}

console.log('mold-breaker-crit: ok');
