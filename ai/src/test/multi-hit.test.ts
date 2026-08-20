import assert from 'node:assert/strict';
import {enumerateMoveActions} from '../actions';
import {calculateActionFacts} from '../calc-adapter';
import {deriveMoveResolution} from '../move-engine';
import {ActionFacts, BattleState, MoveAction} from '../model';
import {applyAction, resolveMoveAction} from '../transition';
import {validateMoveEngineOptions, validateMoveResolution} from '../validation';

function state(target: Partial<BattleState['sides']['player']['party'][number]> = {}): BattleState {
  return {
    generation: 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Cloyster', level: 100,
        hp: {current: 100, max: 100}, moves: [{name: 'Scale Shot', pp: 15, maxPP: 15}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}], ...target,
      }]},
    },
  };
}

function move(battle: BattleState): MoveAction {
  return enumerateMoveActions(battle, 'ai').find(action => action.moveName === 'Scale Shot')!;
}

function contactMove(battle: BattleState): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName: 'Double Slap', targetIds: ['player-1']};
}

function namedMove(moveName: string): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

const factsState = state();
const factsAction = move(factsState);
const facts = calculateActionFacts(factsState, factsAction);
assert.equal(facts.isMultiHit, true);
// Scale Shot is a 2-5 hit move. `hits` carries the calculator's fixed pin of
// three, which is what the sampler falls back to; the BOUNDS span the range
// the engine actually rolls. Asserting min/max at three hits — as this did —
// pinned the calculator's display convention as if it were the game.
assert.equal(facts.damage?.hits, 3);
assert.deepEqual(facts.damage?.hitRange, [2, 5]);
assert.equal(facts.damage?.min, facts.damage!.rolls[0] * 2);
assert.equal(facts.damage?.max, facts.damage!.rolls[facts.damage!.rolls.length - 1] * 5);

// Two engine draws precede the damage rolls now: the variable multi-hit
// COUNT (D2) and the critical-hit event (D1). 0.5 holds the count at three
// (this fixture's expectation) and 0.9 declines the crit, so the per-hit
// assertions below still read the ordinary roll table.
// Parental Bond is not a variable multi-hit, so it draws only the crit.
const noCrit = (rest: number, preamble: number[] = [0.9]) => {
  let index = 0;
  return () => (index < preamble.length ? preamble[index++] : rest);
};
const sampled = deriveMoveResolution(factsState, factsAction, {
  facts, hit: true, random: noCrit(0, [0.5, 0.9]),
});
validateMoveEngineOptions(factsState, factsAction, {facts});
validateMoveResolution(factsState, factsAction, sampled);
assert.deepEqual(sampled.hitDamageByTarget?.['player-1'], [facts.damage!.rolls[0], facts.damage!.rolls[0], facts.damage!.rolls[0]]);
assert.equal(sampled.damageByTarget?.['player-1'], facts.damage!.rolls[0] * 3);
assert.deepEqual(sampled.trace?.hitDamageRollsByTarget?.['player-1'], sampled.hitDamageByTarget?.['player-1']);
const sampledApplied = applyAction(factsState, factsAction, sampled);
assert.equal(sampledApplied.sides.player.party[0].hp.current,
  1000 - facts.damage!.rolls[0] * 3);

const skillLinkState = state();
skillLinkState.sides.ai.party[0] = {
  ...skillLinkState.sides.ai.party[0], ability: 'Skill Link', moves: [{name: 'Double Slap'}],
};
const skillLinkAction = namedMove('Double Slap');
const activeSkillLinkFacts = calculateActionFacts(skillLinkState, skillLinkAction);
assert.equal(activeSkillLinkFacts.damage?.hits, 5);
const suppressedSkillLinkFacts = calculateActionFacts({...skillLinkState, sides: {
  ...skillLinkState.sides,
  ai: {...skillLinkState.sides.ai, party: skillLinkState.sides.ai.party.map(pokemon => ({
    ...pokemon, abilityOn: false,
  }))},
}}, skillLinkAction);
assert.notEqual(suppressedSkillLinkFacts.damage?.hits, 5);

const parentalState = state();
parentalState.sides.ai.party[0] = {
  ...parentalState.sides.ai.party[0], species: 'Kangaskhan', ability: 'Parental Bond',
  moves: [{name: 'Tackle'}],
};
const parentalAction = namedMove('Tackle');
const parentalFacts = calculateActionFacts(parentalState, parentalAction);
assert.equal(parentalFacts.isMultiHit, true);
assert.equal(parentalFacts.damage?.hits, 2);
assert.equal(parentalFacts.damage?.hitRolls?.length, 2);
assert.equal(parentalFacts.damage?.min,
  parentalFacts.damage!.hitRolls!.reduce((total, rolls) => total + Math.min(...rolls), 0));
const parentalResolution = deriveMoveResolution(parentalState, parentalAction, {
  facts: parentalFacts, hit: true, random: noCrit(0),
});
assert.deepEqual(parentalResolution.hitDamageByTarget?.['player-1'], [
  parentalFacts.damage!.hitRolls![0][0], parentalFacts.damage!.hitRolls![1][0],
]);
assert.equal(parentalResolution.damageByTarget?.['player-1'],
  parentalFacts.damage!.hitRolls![0][0] + parentalFacts.damage!.hitRolls![1][0]);
const parentalFixedFacts = calculateActionFacts(parentalState, namedMove('Super Fang'));
assert.equal(parentalFixedFacts.isMultiHit, true);
assert.equal(parentalFixedFacts.damage?.hits, 2);
assert.deepEqual(parentalFixedFacts.damage?.hitRolls?.map(rolls => rolls.length), [1, 1]);
const parentalSuppressed = {...parentalState, sides: {...parentalState.sides, ai: {
  ...parentalState.sides.ai,
  party: parentalState.sides.ai.party.map(pokemon => ({...pokemon, abilityOn: false})),
}}};
const parentalSuppressedFacts = calculateActionFacts(parentalSuppressed, parentalAction);
assert.equal(parentalSuppressedFacts.isMultiHit, false);
assert.equal(parentalSuppressedFacts.damage?.hitRolls, undefined);
const parentalSuppressedFixedFacts = calculateActionFacts(parentalSuppressed, namedMove('Super Fang'));
const plainFixedFacts = calculateActionFacts({...parentalSuppressed, sides: {...parentalSuppressed.sides, ai: {
  ...parentalSuppressed.sides.ai,
  party: parentalSuppressed.sides.ai.party.map(pokemon => ({...pokemon, ability: undefined})),
}}}, namedMove('Super Fang'));
assert.equal(parentalSuppressedFixedFacts.damage?.max, plainFixedFacts.damage?.max);

const parentalDoubles = {...parentalState, mode: 'Doubles' as const, sides: {
  ...parentalState.sides,
  ai: {...parentalState.sides.ai, activeIds: ['ai-1', 'ai-2'], party: [
    ...parentalState.sides.ai.party,
    {id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: []},
  ]},
  player: {...parentalState.sides.player, activeIds: ['player-1', 'player-2'], party: [
    ...parentalState.sides.player.party,
    {id: 'player-2', species: 'Pikachu', level: 100, hp: {current: 1000, max: 1000}, moves: []},
  ]},
}};
const parentalSpreadFacts = calculateActionFacts(parentalDoubles, {
  kind: 'move', actorId: 'ai-1', moveName: 'Earthquake', targetIds: ['player-1', 'player-2'],
});
assert.equal(parentalSpreadFacts.isMultiHit, false);
assert.equal(parentalSpreadFacts.damage?.hits, undefined);

const battleBondState = state({hp: {current: 100, max: 100}});
battleBondState.sides.ai.party[0] = {
  ...battleBondState.sides.ai.party[0], species: 'Greninja', ability: 'Battle Bond',
  moves: [{name: 'Tackle'}],
};
battleBondState.sides.player.party.push({
  id: 'player-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100}, moves: [],
});
const battleBondResolution = deriveMoveResolution(battleBondState, {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
}, {
  facts: barrierFacts(), hit: true,
});
assert.equal(battleBondResolution.speciesOverrideByPokemon?.['ai-1'], 'Greninja-Ash');
assert.deepEqual(battleBondResolution.boostsByPokemon?.['ai-1'], {atk: 1, spa: 1, spe: 1});
const ashWaterShuriken = {...battleBondState, sides: {...battleBondState.sides,
  ai: {...battleBondState.sides.ai, party: battleBondState.sides.ai.party.map(pokemon => ({
    ...pokemon, speciesOverride: 'Greninja-Ash', moves: [{name: 'Water Shuriken'}],
  }))},
}};
const ashWaterShurikenFacts = calculateActionFacts(ashWaterShuriken, {
  kind: 'move', actorId: 'ai-1', moveName: 'Water Shuriken', targetIds: ['player-1'],
});
assert.equal(ashWaterShurikenFacts.damage?.hits, 3);

const stanceShieldState = state();
stanceShieldState.sides.ai.party[0] = {
  ...stanceShieldState.sides.ai.party[0], species: 'Aegislash-Shield', ability: 'Stance Change',
  moves: [{name: 'Tackle'}],
};
const stanceAction: MoveAction = {
  kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1'],
};
const stanceShieldFacts = calculateActionFacts(stanceShieldState, stanceAction);
const stanceBladeState = {...stanceShieldState, sides: {...stanceShieldState.sides,
  ai: {...stanceShieldState.sides.ai, party: stanceShieldState.sides.ai.party.map(pokemon => ({
    ...pokemon, species: 'Aegislash-Blade',
  }))},
}};
const stanceBladeFacts = calculateActionFacts(stanceBladeState, stanceAction);
assert.equal(stanceShieldFacts.damage?.max, stanceBladeFacts.damage?.max);
const stanceResolution = deriveMoveResolution(stanceShieldState, stanceAction, {
  facts: stanceShieldFacts, hit: true,
});
assert.equal(stanceResolution.speciesOverrideByPokemon?.['ai-1'], 'Aegislash-Blade');
const stanceShieldReturnState = {...stanceShieldState, sides: {...stanceShieldState.sides,
  ai: {...stanceShieldState.sides.ai, party: stanceShieldState.sides.ai.party.map(pokemon => ({
    ...pokemon, speciesOverride: 'Aegislash-Blade', moves: [{name: "King's Shield"}],
  }))},
}};
const stanceShieldReturnResolution = deriveMoveResolution(stanceShieldReturnState, {
  kind: 'move', actorId: 'ai-1', moveName: "King's Shield", targetIds: ['ai-1'],
}, {facts: {moveCategory: 'Status'}, hit: true});
assert.equal(stanceShieldReturnResolution.speciesOverrideByPokemon?.['ai-1'], 'Aegislash-Shield');

const substituteState = state({substituteHp: 50});
const substituteAction = move(substituteState);
const substituteResolution = resolveMoveAction(substituteState, substituteAction, {
  hit: true,
  damageByTarget: {'player-1': 75},
  hitDamageByTarget: {'player-1': [25, 25, 25]},
});
assert.equal(substituteResolution.sides.player.party[0].hp.current, 975);
assert.equal(substituteResolution.sides.player.party[0].substituteHp, undefined);

const endureState = state({hp: {current: 100, max: 100}, volatile: {endure: {turns: 1}}});
const endureAction = move(endureState);
const endured = resolveMoveAction(endureState, endureAction, {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(endured.sides.player.party[0].hp.current, 1);

function barrierFacts(moveType: ActionFacts['moveType'] = 'Normal'): ActionFacts {
  return {
    moveCategory: 'Physical', moveType, isMultiHit: true,
    moveAccuracy: true, damage: {
      rolls: [60], hits: 3, min: 180, max: 180, targetHp: 100,
      possibleKO: true, guaranteedKO: true,
    },
  };
}

function fatalBarrierFacts(moveType: ActionFacts['moveType'] = 'Normal'): ActionFacts {
  return {
    ...barrierFacts(moveType),
    damage: {
      rolls: [100], hits: 3, min: 300, max: 300, targetHp: 100,
      possibleKO: true, guaranteedKO: true,
    },
  };
}

const sturdyState = state({hp: {current: 100, max: 100}, ability: 'Sturdy'});
const sturdyResolution = deriveMoveResolution(sturdyState, move(sturdyState), {
  facts: barrierFacts(), hit: true,
});
validateMoveResolution(sturdyState, move(sturdyState), sturdyResolution);
assert.deepEqual(sturdyResolution.hitDamageByTarget?.['player-1'], [60, 60, 60]);
assert.equal(applyAction(sturdyState, move(sturdyState), sturdyResolution).sides.player.party[0].hp.current, 0);

const sashState = state({hp: {current: 100, max: 100}, item: 'Focus Sash'});
const sashResolution = deriveMoveResolution(sashState, move(sashState), {
  facts: barrierFacts(), hit: true,
});
assert.deepEqual(sashResolution.hitDamageByTarget?.['player-1'], [60, 60, 60]);
assert.equal(sashResolution.consumedItemByPokemon?.['player-1'], undefined);
const fatalSturdyResolution = deriveMoveResolution(sturdyState, move(sturdyState), {
  facts: fatalBarrierFacts(), hit: true,
});
assert.deepEqual(fatalSturdyResolution.hitDamageByTarget?.['player-1'], [99, 100, 100]);
const fatalSashResolution = deriveMoveResolution(sashState, move(sashState), {
  facts: fatalBarrierFacts(), hit: true,
});
assert.deepEqual(fatalSashResolution.hitDamageByTarget?.['player-1'], [99, 100, 100]);
assert.equal(fatalSashResolution.consumedItemByPokemon?.['player-1'], 'Focus Sash');

const iceFaceState = state({species: 'Eiscue', ability: 'Ice Face', hp: {current: 100, max: 100}});
const iceFaceResolution = deriveMoveResolution(iceFaceState, move(iceFaceState), {
  facts: barrierFacts(), hit: true,
});
assert.deepEqual(iceFaceResolution.hitDamageByTarget?.['player-1'], [0, 60, 60]);
assert.equal(iceFaceResolution.speciesOverrideByPokemon?.['player-1'], 'Eiscue-Noice');
assert.equal(applyAction(iceFaceState, move(iceFaceState), iceFaceResolution).sides.player.party[0].hp.current, 0);

const substituteSturdyState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, ability: 'Sturdy',
});
const substituteSturdyResolution = deriveMoveResolution(
  substituteSturdyState, move(substituteSturdyState), {facts: barrierFacts(), hit: true},
);
assert.deepEqual(substituteSturdyResolution.hitDamageByTarget?.['player-1'], [60, 60, 60]);

const substituteSashState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, item: 'Focus Sash',
});
const substituteSashResolution = deriveMoveResolution(
  substituteSashState, move(substituteSashState), {facts: barrierFacts(), hit: true},
);
assert.deepEqual(substituteSashResolution.hitDamageByTarget?.['player-1'], [60, 60, 60]);
assert.equal(substituteSashResolution.consumedItemByPokemon?.['player-1'], undefined);
const substituteFatalSturdyResolution = deriveMoveResolution(
  substituteSturdyState, move(substituteSturdyState), {facts: fatalBarrierFacts(), hit: true},
);
assert.deepEqual(substituteFatalSturdyResolution.hitDamageByTarget?.['player-1'], [100, 99, 100]);
const substituteFatalSashResolution = deriveMoveResolution(
  substituteSashState, move(substituteSashState), {facts: fatalBarrierFacts(), hit: true},
);
assert.deepEqual(substituteFatalSashResolution.hitDamageByTarget?.['player-1'], [100, 99, 100]);
assert.equal(substituteFatalSashResolution.consumedItemByPokemon?.['player-1'], 'Focus Sash');

const substituteIceFaceState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, species: 'Eiscue', ability: 'Ice Face',
});
const substituteIceFaceResolution = deriveMoveResolution(
  substituteIceFaceState, move(substituteIceFaceState), {facts: barrierFacts(), hit: true},
);
assert.deepEqual(substituteIceFaceResolution.hitDamageByTarget?.['player-1'], [60, 0, 60]);

const substituteResistBerryState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, item: 'Occa Berry',
});
const substituteResistBerryFacts = barrierFacts('Fire');
substituteResistBerryFacts.isSuperEffective = true;
const substituteResistBerryResolution = deriveMoveResolution(
  substituteResistBerryState,
  move(substituteResistBerryState),
  {facts: substituteResistBerryFacts, hit: true},
);
assert.deepEqual(substituteResistBerryResolution.hitDamageByTarget?.['player-1'], [60, 30, 60]);
assert.equal(substituteResistBerryResolution.consumedItemByPokemon?.['player-1'], 'Occa Berry');

const substituteWeaknessPolicyState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, item: 'Weakness Policy',
});
const substituteWeaknessPolicyFacts = barrierFacts('Fire');
substituteWeaknessPolicyFacts.isSuperEffective = true;
const substituteWeaknessPolicyResolution = deriveMoveResolution(
  substituteWeaknessPolicyState,
  move(substituteWeaknessPolicyState),
  {facts: substituteWeaknessPolicyFacts, hit: true},
);
assert.deepEqual(substituteWeaknessPolicyResolution.boostsByPokemon?.['player-1'], {atk: 2, spa: 2});
assert.equal(substituteWeaknessPolicyResolution.consumedItemByPokemon?.['player-1'], 'Weakness Policy');

const pickpocketSubstituteEndureState = state({
  hp: {current: 100, max: 100}, substituteHp: 50,
  ability: 'Pickpocket', volatile: {endure: {turns: 1}},
});
pickpocketSubstituteEndureState.sides.ai.party[0].item = 'Leftovers';
const pickpocketSubstituteEndureResolution = deriveMoveResolution(
  pickpocketSubstituteEndureState,
  contactMove(pickpocketSubstituteEndureState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(pickpocketSubstituteEndureResolution.itemByPokemon?.['ai-1'], null);
assert.equal(pickpocketSubstituteEndureResolution.itemByPokemon?.['player-1'], 'Leftovers');

const perishBodySubstituteState = state({ability: 'Perish Body', substituteHp: 50});
const perishBodySubstituteFacts = barrierFacts();
perishBodySubstituteFacts.damage = {
  ...perishBodySubstituteFacts.damage!, rolls: [10], min: 30, max: 30,
};
const perishBodySubstituteResolution = deriveMoveResolution(
  perishBodySubstituteState,
  contactMove(perishBodySubstituteState),
  {facts: perishBodySubstituteFacts, hit: true},
);
assert.equal(perishBodySubstituteResolution.volatileByPokemon, undefined);

const roughSkinState = state({ability: 'Rough Skin'});
const roughSkinResolution = deriveMoveResolution(roughSkinState, contactMove(roughSkinState), {
  facts: barrierFacts(), hit: true,
});
assert.equal(roughSkinResolution.hpDeltaByPokemon?.['ai-1'], -36);

const rockyHelmetState = state({ability: 'Iron Barbs', item: 'Rocky Helmet'});
const rockyHelmetResolution = deriveMoveResolution(rockyHelmetState, contactMove(rockyHelmetState), {
  facts: barrierFacts(), hit: true,
});
assert.equal(rockyHelmetResolution.hpDeltaByPokemon?.['ai-1'], -84);

const substituteContactState = state({ability: 'Rough Skin', substituteHp: 50});
const substituteContactResolution = deriveMoveResolution(substituteContactState, contactMove(substituteContactState), {
  facts: barrierFacts(), hit: true,
});
assert.equal(substituteContactResolution.hpDeltaByPokemon?.['ai-1'], -24);

function afterFirstMiss(): () => number {
  let calls = 0;
  return () => calls++ === 0 ? 0.99 : 0;
}

const staticMultiHitState = state({ability: 'Static'});
const staticMultiHitResolution = deriveMoveResolution(staticMultiHitState, contactMove(staticMultiHitState), {
  facts: barrierFacts(), hit: true, random: afterFirstMiss(),
});
assert.equal(staticMultiHitResolution.statusByPokemon?.['ai-1'], 'par');

const poisonTouchMultiHitState = state();
poisonTouchMultiHitState.sides.ai.party[0].ability = 'Poison Touch';
const poisonTouchMultiHitResolution = deriveMoveResolution(
  poisonTouchMultiHitState,
  contactMove(poisonTouchMultiHitState),
  {facts: barrierFacts(), hit: true, random: afterFirstMiss()},
);
assert.equal(poisonTouchMultiHitResolution.statusByPokemon?.['player-1'], 'psn');

const gooeyMultiHitState = state({ability: 'Gooey'});
const gooeyMultiHitResolution = deriveMoveResolution(gooeyMultiHitState, contactMove(gooeyMultiHitState), {
  facts: barrierFacts(), hit: true,
});
assert.equal(gooeyMultiHitResolution.boostsByPokemon?.['ai-1']?.spe, -3);

const aftermathSubstituteState = state({
  ability: 'Aftermath', hp: {current: 100, max: 100}, substituteHp: 50,
});
const aftermathSubstituteResolution = deriveMoveResolution(
  aftermathSubstituteState,
  contactMove(aftermathSubstituteState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(aftermathSubstituteResolution.hpDeltaByPokemon?.['ai-1'], -25);

const moxieSubstituteState = state({hp: {current: 100, max: 100}, substituteHp: 50});
moxieSubstituteState.sides.ai.party[0].ability = 'Moxie';
const moxieSubstituteResolution = deriveMoveResolution(
  moxieSubstituteState,
  contactMove(moxieSubstituteState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(moxieSubstituteResolution.boostsByPokemon?.['ai-1']?.atk, 1);

const cursedBodyMultiHitState = state({ability: 'Cursed Body'});
const cursedBodyMultiHitResolution = deriveMoveResolution(
  cursedBodyMultiHitState,
  contactMove(cursedBodyMultiHitState),
  {facts: barrierFacts(), hit: true, random: afterFirstMiss()},
);
assert.deepEqual(cursedBodyMultiHitResolution.volatileByPokemon?.['ai-1']?.disable, {
  turns: 4, moveName: 'Double Slap',
});

const weakArmorMultiHitState = state({ability: 'Weak Armor'});
const weakArmorMultiHitResolution = deriveMoveResolution(
  weakArmorMultiHitState,
  contactMove(weakArmorMultiHitState),
  {facts: barrierFacts(), hit: true},
);
assert.deepEqual(weakArmorMultiHitResolution.boostsByPokemon?.['player-1'], {def: -3, spe: 6});

const staminaMultiHitState = state({ability: 'Stamina'});
const staminaMultiHitResolution = deriveMoveResolution(
  staminaMultiHitState,
  contactMove(staminaMultiHitState),
  {facts: barrierFacts(), hit: true},
);
assert.deepEqual(staminaMultiHitResolution.boostsByPokemon?.['player-1'], {def: 3});

const waterCompactionMultiHitState = state({ability: 'Water Compaction'});
const waterCompactionMultiHitResolution = deriveMoveResolution(
  waterCompactionMultiHitState,
  contactMove(waterCompactionMultiHitState),
  {facts: barrierFacts('Water'), hit: true},
);
assert.deepEqual(waterCompactionMultiHitResolution.boostsByPokemon?.['player-1'], {def: 6});

const cottonDownMultiHitState = state({ability: 'Cotton Down'});
cottonDownMultiHitState.mode = 'Doubles';
cottonDownMultiHitState.sides.ai.activeIds = ['ai-1', 'ai-2'];
cottonDownMultiHitState.sides.ai.party.push({
  id: 'ai-2', species: 'Mewtwo', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const cottonDownMultiHitResolution = deriveMoveResolution(
  cottonDownMultiHitState,
  contactMove(cottonDownMultiHitState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(cottonDownMultiHitResolution.boostsByPokemon?.['ai-2']?.spe, -3);

const toxicDebrisMultiHitState = state({ability: 'Toxic Debris'});
const toxicDebrisMultiHitResolution = deriveMoveResolution(
  toxicDebrisMultiHitState,
  contactMove(toxicDebrisMultiHitState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(toxicDebrisMultiHitResolution.sideEffectsBySide?.player?.toxicSpikes, 2);

const wimpOutSubstituteState = state({
  hp: {current: 200, max: 200}, substituteHp: 50, ability: 'Wimp Out',
});
wimpOutSubstituteState.sides.player.party.push({
  id: 'player-2', species: 'Mewtwo', level: 100,
  hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
});
const wimpOutSubstituteResolution = deriveMoveResolution(
  wimpOutSubstituteState,
  contactMove(wimpOutSubstituteState),
  {facts: barrierFacts(), hit: true},
);
assert.equal(wimpOutSubstituteResolution.forcedSwitchByPokemon?.['player-1'], true);

const incinerateSubstituteState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, item: 'Sitrus Berry',
});
const incinerateSubstituteFacts = barrierFacts('Fire');
incinerateSubstituteFacts.moveCategory = 'Special';
incinerateSubstituteFacts.damage = {
  ...incinerateSubstituteFacts.damage!, rolls: [40], min: 120, max: 120,
};
const incinerateSubstituteResolution = deriveMoveResolution(
  incinerateSubstituteState,
  namedMove('Incinerate'),
  {facts: incinerateSubstituteFacts, hit: true},
);
assert.equal(incinerateSubstituteResolution.itemByPokemon?.['player-1'], null);

const magicianSubstituteState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, item: 'Leftovers',
});
magicianSubstituteState.sides.ai.party[0].ability = 'Magician';
const magicianSubstituteFacts = barrierFacts();
magicianSubstituteFacts.damage = {
  ...magicianSubstituteFacts.damage!, rolls: [40], min: 120, max: 120,
};
const magicianSubstituteResolution = deriveMoveResolution(
  magicianSubstituteState,
  namedMove('Tackle'),
  {facts: magicianSubstituteFacts, hit: true},
);
assert.equal(magicianSubstituteResolution.itemByPokemon?.['ai-1'], 'Leftovers');
assert.equal(magicianSubstituteResolution.itemByPokemon?.['player-1'], null);

const secondaryMultiHitState = state();
let secondaryRollIndex = 0;
const secondaryRolls = [0, 0, 0, 0.99, 0, 0.99];
const secondaryMultiHitResolution = deriveMoveResolution(
  secondaryMultiHitState,
  contactMove(secondaryMultiHitState),
  {
    facts: {
      ...barrierFacts(),
      secondaryEffects: [{chance: 30, status: 'par'}],
    },
    hit: true,
    random: () => secondaryRolls[secondaryRollIndex++] ?? 0.99,
  },
);
assert.equal(secondaryMultiHitResolution.statusByPokemon?.['player-1'], 'par');
assert.equal(secondaryMultiHitResolution.trace?.secondaryRolls?.['player-1:0:hit1'], 0.99);
assert.equal(secondaryMultiHitResolution.trace?.secondaryRolls?.['player-1:0:hit2'], 0);
assert.doesNotThrow(() => validateMoveResolution(
  secondaryMultiHitState, contactMove(secondaryMultiHitState), secondaryMultiHitResolution,
));

const aggregateSecondaryFacts: ActionFacts = {
  moveCategory: 'Physical', moveType: 'Normal', isMultiHit: true,
  damage: {rolls: [30], min: 30, max: 30, targetHp: 100, possibleKO: false, guaranteedKO: false},
  secondaryEffects: [{chance: 100, status: 'par'}],
};
const aggregateSecondarySubstitute = state({substituteHp: 100});
assert.equal(deriveMoveResolution(
  aggregateSecondarySubstitute, namedMove('Double Slap'),
  {facts: aggregateSecondaryFacts, hit: true, random: () => 0},
).statusByPokemon, undefined);
const aggregateSecondaryBreak = state({substituteHp: 20});
const aggregateSecondaryBreakResolution = deriveMoveResolution(
  aggregateSecondaryBreak, namedMove('Double Slap'),
  {facts: aggregateSecondaryFacts, hit: true, random: () => 0},
);
assert.equal(aggregateSecondaryBreakResolution.statusByPokemon?.['player-1'], 'par');

const selfSecondaryMultiHitState = state();
const selfSecondaryMultiHitResolution = deriveMoveResolution(
  selfSecondaryMultiHitState,
  contactMove(selfSecondaryMultiHitState),
  {
    facts: {
      ...barrierFacts(),
      secondaryEffects: [{chance: 100, target: 'self', boosts: {spa: 1}}],
    },
    hit: true,
    random: () => 0,
  },
);
assert.deepEqual(selfSecondaryMultiHitResolution.boostsByPokemon?.['ai-1'], {spa: 3});

const bideSubstituteState = state({
  hp: {current: 100, max: 100}, substituteHp: 50,
  volatile: {bide: {turns: 1, damage: 0}},
});
const bideSubstituteNext = resolveMoveAction(bideSubstituteState, move(bideSubstituteState), {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(bideSubstituteNext.sides.player.party[0].volatile?.bide?.damage, 100);

const rageFistHitState = state({hp: {current: 100, max: 100}, rageFistHits: 0});
const rageFistHitNext = resolveMoveAction(rageFistHitState, move(rageFistHitState), {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(rageFistHitNext.sides.player.party[0].rageFistHits, 2);

const lastDamageSubstituteState = state({hp: {current: 100, max: 100}, substituteHp: 50});
const lastDamageSubstituteNext = resolveMoveAction(lastDamageSubstituteState, move(lastDamageSubstituteState), {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(lastDamageSubstituteNext.lastDamageTakenByPokemon?.['player-1']?.damage, 100);

const destinyBondSubstituteState = state({
  hp: {current: 100, max: 100}, substituteHp: 50,
  volatile: {destinyBond: {turns: 1}},
});
const destinyBondSubstituteNext = resolveMoveAction(destinyBondSubstituteState, move(destinyBondSubstituteState), {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(destinyBondSubstituteNext.sides.ai.party[0].hp.current, 0);

const grudgeSubstituteState = state({
  hp: {current: 100, max: 100}, substituteHp: 50, volatile: {grudge: {turns: 1}},
});
const grudgeSubstituteNext = resolveMoveAction(grudgeSubstituteState, move(grudgeSubstituteState), {
  hit: true,
  damageByTarget: {'player-1': 180},
  hitDamageByTarget: {'player-1': [60, 60, 60]},
});
assert.equal(grudgeSubstituteNext.sides.ai.party[0].moves[0].pp, 0);

console.log('Multi-hit fixtures passed');
