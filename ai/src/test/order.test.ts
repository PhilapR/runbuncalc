import assert from 'node:assert/strict';
import {BattleState, MoveAction} from '../model';
import {getActionOrderFacts, orderActions} from '../order';
import {applySwitchAction, beginNextTurn, resolveMoveAction} from '../transition';

function makeState(): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
        moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function action(moveName = 'Tackle'): MoveAction {
  return {kind: 'move', actorId: 'ai-1', moveName, targetIds: ['player-1']};
}

const scarfState = makeState();
const baseSpeed = getActionOrderFacts(scarfState, action()).speed;
scarfState.sides.ai.party[0].item = 'Choice Scarf';
const scarfSpeed = getActionOrderFacts(scarfState, action()).speed;
assert.equal(scarfSpeed, baseSpeed * 1.5);
scarfState.field.magicRoom = true;
assert.equal(getActionOrderFacts(scarfState, action()).speed, baseSpeed);

const klutzState = makeState();
klutzState.sides.ai.party[0].item = 'Choice Scarf';
klutzState.sides.ai.party[0].ability = 'Klutz';
assert.equal(getActionOrderFacts(klutzState, action()).speed, baseSpeed);

const klutzPowerItemState = makeState();
klutzPowerItemState.sides.ai.party[0].item = 'Macho Brace';
klutzPowerItemState.sides.ai.party[0].ability = 'Klutz';
assert.equal(getActionOrderFacts(klutzPowerItemState, action()).speed, baseSpeed * 0.5);
klutzPowerItemState.field.magicRoom = true;
assert.equal(getActionOrderFacts(klutzPowerItemState, action()).speed, baseSpeed);

const laggingState = makeState();
laggingState.sides.ai.party[0].item = 'Lagging Tail';
assert.equal(getActionOrderFacts(laggingState, action()).movesLast, true);
laggingState.field.magicRoom = true;
assert.equal(getActionOrderFacts(laggingState, action()).movesLast, false);

const klutzLaggingState = makeState();
klutzLaggingState.sides.ai.party[0].item = 'Full Incense';
klutzLaggingState.sides.ai.party[0].ability = 'Klutz';
assert.equal(getActionOrderFacts(klutzLaggingState, action()).movesLast, false);

const quickFeetState = makeState();
quickFeetState.sides.ai.party[0].ability = 'Quick Feet';
quickFeetState.sides.ai.party[0].status = 'par';
const quickFeetGen3 = {...quickFeetState, generation: 3 as BattleState['generation']};
const quickFeetGen3Base = {...quickFeetGen3, sides: {...quickFeetGen3.sides,
  ai: {...quickFeetGen3.sides.ai, party: quickFeetGen3.sides.ai.party.map(pokemon => ({...pokemon, ability: undefined}))},
}};
assert.equal(getActionOrderFacts(quickFeetGen3, action()).speed,
  getActionOrderFacts(quickFeetGen3Base, action()).speed);
const quickFeetGen4 = {...quickFeetState, generation: 4 as BattleState['generation']};
const quickFeetGen4Base = {...quickFeetGen4, sides: {...quickFeetGen4.sides,
  ai: {...quickFeetGen4.sides.ai, party: quickFeetGen4.sides.ai.party.map(pokemon => ({...pokemon, ability: undefined}))},
}};
assert.equal(getActionOrderFacts(quickFeetGen4, action()).speed,
  getActionOrderFacts(quickFeetGen4Base, action()).speed * 6);

const galeWingsState = makeState();
galeWingsState.sides.ai.party[0].ability = 'Gale Wings';
const galeWingsGen5 = {...galeWingsState, generation: 5 as BattleState['generation']};
const galeWingsGen6 = {...galeWingsState, generation: 6 as BattleState['generation']};
assert.equal(getActionOrderFacts(galeWingsGen5, action('Gust')).priority, 0);
assert.equal(getActionOrderFacts(galeWingsGen6, action('Gust')).priority, 1);

const triageState = makeState();
triageState.sides.ai.party[0].ability = 'Triage';
const triageGen6 = {...triageState, generation: 6 as BattleState['generation']};
const triageGen7 = {...triageState, generation: 7 as BattleState['generation']};
assert.equal(getActionOrderFacts(triageGen6, action('Recover')).priority, 0);
assert.equal(getActionOrderFacts(triageGen7, action('Recover')).priority, 3);
for (const moveName of ['Dream Eater', 'Floral Healing', 'Life Dew', 'Purify', 'Wish']) {
  assert.equal(getActionOrderFacts(triageGen7, action(moveName)).priority, 3);
}
assert.equal(getActionOrderFacts(triageGen7, action('Tackle')).priority, 0);

const fallbackMoveState = {...makeState(), generation: 9 as const};
assert.doesNotThrow(() => getActionOrderFacts(fallbackMoveState, action('Electro Shot')));
assert.equal(getActionOrderFacts(fallbackMoveState, action('Electro Shot')).priority, 0);
assert.doesNotThrow(() => getActionOrderFacts(makeState(), action('Caller Defined Move')));
const customOrderState = makeState();
customOrderState.sides.ai.party[0].moves = [{
  name: 'Caller Defined Priority Move', type: 'Flying', category: 'Physical', priority: 2,
}];
assert.equal(getActionOrderFacts(customOrderState, action('Caller Defined Priority Move')).priority, 2);
customOrderState.sides.ai.party[0].ability = 'Gale Wings';
customOrderState.sides.ai.party[0].moves[0].priority = 0;
assert.equal(getActionOrderFacts(customOrderState, action('Caller Defined Priority Move')).priority, 1);

const customHealingState = makeState();
customHealingState.generation = 9;
customHealingState.sides.ai.party[0].ability = 'Triage';
customHealingState.sides.ai.party[0].moves = [{
  name: 'Caller Defined Healing Move', type: 'Normal', category: 'Special', heal: true,
}];
assert.equal(getActionOrderFacts(customHealingState, action('Caller Defined Healing Move')).priority, 3);
customHealingState.sides.ai.party[0].moves[0].heal = false;
assert.equal(getActionOrderFacts(customHealingState, action('Caller Defined Healing Move')).priority, 0);

const swiftSwimState = makeState();
swiftSwimState.field.weather = 'Rain';
swiftSwimState.sides.ai.party[0].ability = 'Swift Swim';
const swiftSwimGen2 = {...swiftSwimState, generation: 2 as BattleState['generation']};
const swiftSwimGen2Base = {...swiftSwimGen2, sides: {...swiftSwimGen2.sides,
  ai: {...swiftSwimGen2.sides.ai, party: swiftSwimGen2.sides.ai.party.map(pokemon => ({...pokemon, ability: undefined}))},
}};
assert.equal(getActionOrderFacts(swiftSwimGen2, action()).speed,
  getActionOrderFacts(swiftSwimGen2Base, action()).speed);
const swiftSwimGen3 = {...swiftSwimState, generation: 3 as BattleState['generation']};
const swiftSwimGen3Base = {...swiftSwimGen3, sides: {...swiftSwimGen3.sides,
  ai: {...swiftSwimGen3.sides.ai, party: swiftSwimGen3.sides.ai.party.map(pokemon => ({...pokemon, ability: undefined}))},
}};
assert.equal(getActionOrderFacts(swiftSwimGen3, action()).speed,
  getActionOrderFacts(swiftSwimGen3Base, action()).speed * 2);

const stallState = makeState();
stallState.sides.ai.party[0].ability = 'Stall';
assert.equal(getActionOrderFacts({...stallState, generation: 3 as BattleState['generation']}, action()).movesLast, false);
assert.equal(getActionOrderFacts({...stallState, generation: 4 as BattleState['generation']}, action()).movesLast, true);
const myceliumState = makeState();
myceliumState.sides.ai.party[0].ability = 'Mycelium Might';
assert.equal(getActionOrderFacts({...myceliumState, generation: 8 as BattleState['generation']}, action('Tail Whip')).movesLast, false);
assert.equal(getActionOrderFacts({...myceliumState, generation: 9 as BattleState['generation']}, action('Tail Whip')).movesLast, true);

const quickClawState = makeState();
quickClawState.sides.ai.party[0].item = 'Quick Claw';
quickClawState.sides.ai.party[0].ability = 'Klutz';
assert.equal(getActionOrderFacts(quickClawState, action(), 0).itemPriority, false);
const ordinaryQuickClawState = makeState();
ordinaryQuickClawState.sides.ai.party[0].item = 'Quick Claw';
assert.equal(getActionOrderFacts(ordinaryQuickClawState, action(), 0).itemPriority, true);
ordinaryQuickClawState.sides.player.party[0].species = 'Rattata';
const playerAction: MoveAction = {
  kind: 'move', actorId: 'player-1', moveName: 'Tackle', targetIds: ['ai-1'],
};
assert.equal(orderActions(ordinaryQuickClawState, [action(), playerAction], {random: () => 0})[0].actorId, 'ai-1');
const custapState = makeState();
custapState.sides.ai.party[0].item = 'Custap Berry';
custapState.sides.ai.party[0].hp.current = 25;
assert.equal(getActionOrderFacts(custapState, action()).itemPriority, true);
assert.equal(getActionOrderFacts(custapState, action('Quick Attack')).itemPriority, false);
custapState.field.magicRoom = true;
assert.equal(getActionOrderFacts(custapState, action()).itemPriority, false);
custapState.field.magicRoom = false;
custapState.sides.ai.party[0].ability = 'Klutz';
assert.equal(getActionOrderFacts(custapState, action()).itemPriority, false);
custapState.sides.ai.party[0].ability = 'Gluttony';
custapState.sides.ai.party[0].hp.current = 50;
assert.equal(getActionOrderFacts(custapState, action()).itemPriority, true);
const custapMycelium = {...custapState, generation: 9 as const, sides: {...custapState.sides,
  ai: {...custapState.sides.ai, party: custapState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: 'Mycelium Might',
  }))},
}};
assert.equal(getActionOrderFacts(custapMycelium, action('Toxic')).itemPriority, false);

const unburdenState = makeState();
unburdenState.sides.ai.party[0].ability = 'Unburden';
const unburdenBaseSpeed = getActionOrderFacts(unburdenState, action()).speed;
unburdenState.sides.ai.party[0].itemLost = true;
assert.equal(getActionOrderFacts(unburdenState, action()).speed, unburdenBaseSpeed * 2);
unburdenState.sides.ai.party[0].abilityOn = false;
assert.equal(getActionOrderFacts(unburdenState, action()).speed, unburdenBaseSpeed);

const itemLossState = makeState();
itemLossState.sides.ai.party[0].ability = 'Unburden';
itemLossState.sides.ai.party[0].item = 'Sitrus Berry';
const itemLossNext = resolveMoveAction(itemLossState, action(), {
  hit: true,
  itemByPokemon: {'ai-1': null},
});
assert.equal(itemLossNext.sides.ai.party[0].itemLost, true);
assert.equal(getActionOrderFacts(itemLossNext, action()).speed, unburdenBaseSpeed * 2);

itemLossState.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
  moves: [{name: 'Tackle'}],
});
itemLossState.sides.ai.party[0].itemLost = true;
const switched = applySwitchAction(itemLossState, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(switched.sides.ai.party[0].itemLost, undefined);

const slowStartState = makeState();
slowStartState.generation = 4;
slowStartState.sides.ai.party[0].ability = 'Slow Start';
slowStartState.sides.ai.party[0].abilityOn = true;
slowStartState.sides.ai.party[0].volatile = {slowStart: {turns: 5}};
const slowStartBaseSpeed = getActionOrderFacts({...slowStartState, sides: {
  ...slowStartState.sides,
  ai: {...slowStartState.sides.ai, party: slowStartState.sides.ai.party.map(pokemon => ({
    ...pokemon, ability: undefined, volatile: undefined,
  }))},
}}, action()).speed;
assert.equal(getActionOrderFacts(slowStartState, action()).speed, slowStartBaseSpeed * 0.5);
slowStartState.sides.ai.party[0].volatile = {slowStart: {turns: 5}};
slowStartState.sides.ai.party[0].abilityOn = false;
assert.equal(getActionOrderFacts(slowStartState, action()).speed, slowStartBaseSpeed);

const slowStartEntry = makeState();
slowStartEntry.generation = 4;
slowStartEntry.sides.ai.party[0].ability = 'Slow Start';
slowStartEntry.sides.ai.party[0].abilityOn = true;
slowStartEntry.sides.ai.party.push({
  id: 'ai-2', species: 'Pikachu', level: 100, hp: {current: 100, max: 100},
  moves: [{name: 'Tackle'}], ability: 'Slow Start', abilityOn: true,
});
const slowStartSwitched = applySwitchAction(slowStartEntry, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.deepEqual(slowStartSwitched.sides.ai.party[1].volatile?.slowStart, {turns: 5});
const slowStartAfterOne = beginNextTurn(slowStartSwitched);
assert.equal(slowStartAfterOne.sides.ai.party[1].volatile?.slowStart?.turns, 4);
let slowStartExpired = slowStartAfterOne;
for (let index = 0; index < 4; index++) slowStartExpired = beginNextTurn(slowStartExpired);
assert.equal(slowStartExpired.sides.ai.party[1].volatile?.slowStart, undefined);
const slowStartPreGen = applySwitchAction({...slowStartEntry, generation: 3}, {
  kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2',
});
assert.equal(slowStartPreGen.sides.ai.party[1].volatile?.slowStart, undefined);
const slowStartSuppressed = applySwitchAction({
  ...slowStartEntry,
  sides: {...slowStartEntry.sides, ai: {...slowStartEntry.sides.ai,
    party: slowStartEntry.sides.ai.party.map(pokemon => pokemon.id === 'ai-2'
      ? {...pokemon, abilityOn: false} : pokemon),
  }},
}, {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'});
assert.equal(slowStartSuppressed.sides.ai.party[1].volatile?.slowStart, undefined);
console.log('Order fixtures passed');
