import assert from 'node:assert/strict';
import {enumerateForcedSwitchActions, enumerateMoveActions, enumerateSwitchActions, isGhostType, isSwitchBlockedByAbility} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, GenerationNum} from '../model';
import {applySwitchAction} from '../transition';

function state(options: {
  generation?: GenerationNum;
  actorSpecies?: string;
  actorAbility?: string;
  holderAbility?: string;
} = {}): BattleState {
  return {
    generation: options.generation || 9,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [
        {
          id: 'ai-1', species: options.actorSpecies || 'Pikachu', level: 100,
          hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], ability: options.actorAbility,
        },
        {id: 'ai-2', species: 'Bulbasaur', level: 100, hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}]},
      ]},
      player: {activeIds: ['player-1'], party: [
        {
          id: 'player-1', species: 'Diglett', level: 100,
          hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}], ability: options.holderAbility,
        },
      ]},
    },
  };
}

function voluntarySwitch(state: BattleState) {
  return {kind: 'switch' as const, actorId: 'ai-1', replacementId: 'ai-2'};
}

const arenaTrap = state({holderAbility: 'Arena Trap'});
assert.equal(isSwitchBlockedByAbility(arenaTrap, 'ai-1'), true);
assert.equal(enumerateSwitchActions(arenaTrap).length, 0);
assert.throws(() => applySwitchAction(arenaTrap, voluntarySwitch(arenaTrap)), /opposing trapping ability/);

const airborne = state({holderAbility: 'Arena Trap'});
airborne.sides.ai.party[0].typeOverride = ['Flying'];
assert.equal(isSwitchBlockedByAbility(airborne, 'ai-1'), false);
assert.equal(enumerateSwitchActions(airborne).length, 1);
const balloon = state({holderAbility: 'Arena Trap'});
balloon.sides.ai.party[0].item = 'Air Balloon';
assert.equal(enumerateSwitchActions(balloon).length, 1);
const groundedByGravity = state({holderAbility: 'Arena Trap'});
groundedByGravity.sides.ai.party[0].typeOverride = ['Flying'];
groundedByGravity.field.gravity = true;
assert.equal(enumerateSwitchActions(groundedByGravity).length, 0);

const magnetPull = state({actorSpecies: 'Magnemite', holderAbility: 'Magnet Pull'});
assert.equal(enumerateSwitchActions(magnetPull).length, 0);
const magnetPullNonSteel = state({holderAbility: 'Magnet Pull'});
assert.equal(enumerateSwitchActions(magnetPullNonSteel).length, 1);

const shadowTag = state({holderAbility: 'Shadow Tag'});
assert.equal(enumerateSwitchActions(shadowTag).length, 0);
const shadowTagMirror = state({actorAbility: 'Shadow Tag', holderAbility: 'Shadow Tag'});
assert.equal(enumerateSwitchActions(shadowTagMirror).length, 1);
const ghostEscape = state({actorSpecies: 'Gastly', holderAbility: 'Shadow Tag'});
assert.equal(enumerateSwitchActions(ghostEscape).length, 1);
const plateGhostEscape = state({actorSpecies: 'Arceus', actorAbility: 'Multitype', holderAbility: 'Shadow Tag'});
plateGhostEscape.sides.ai.party[0].item = 'Spooky Plate';
assert.equal(isGhostType(plateGhostEscape, 'ai-1'), true);
assert.equal(enumerateSwitchActions(plateGhostEscape).length, 1);
const genFiveGhost = state({generation: 5, actorSpecies: 'Gastly', holderAbility: 'Shadow Tag'});
assert.equal(enumerateSwitchActions(genFiveGhost).length, 0);

const unavailable = state({generation: 2, holderAbility: 'Arena Trap'});
assert.equal(enumerateSwitchActions(unavailable).length, 1);
const suppressed = state({holderAbility: 'Shadow Tag'});
suppressed.sides.player.party[0].abilitySuppressed = true;
assert.equal(enumerateSwitchActions(suppressed).length, 1);

const shedShellAbility = state({holderAbility: 'Arena Trap'});
shedShellAbility.sides.ai.party[0].item = 'Shed Shell';
assert.equal(enumerateSwitchActions(shedShellAbility).length, 1);
assert.doesNotThrow(() => applySwitchAction(shedShellAbility, voluntarySwitch(shedShellAbility)));
const shedShellMoveTrap = state();
shedShellMoveTrap.sides.ai.party[0].item = 'Shed Shell';
shedShellMoveTrap.sides.ai.party[0].volatile = {trapped: {sourceId: 'player-1'}};
assert.equal(enumerateSwitchActions(shedShellMoveTrap).length, 1);
assert.doesNotThrow(() => applySwitchAction(shedShellMoveTrap, voluntarySwitch(shedShellMoveTrap)));
const suppressedShedShell = state({holderAbility: 'Arena Trap'});
suppressedShedShell.sides.ai.party[0].item = 'Shed Shell';
suppressedShedShell.field.magicRoom = true;
assert.equal(enumerateSwitchActions(suppressedShedShell).length, 0);
const ingrainShedShell = state();
ingrainShedShell.sides.ai.party[0].item = 'Shed Shell';
ingrainShedShell.sides.ai.party[0].volatile = {ingrain: {turns: 1}};
assert.equal(enumerateSwitchActions(ingrainShedShell).length, 0);

const ghostMoveTrap = state({actorSpecies: 'Gastly'});
ghostMoveTrap.sides.ai.party[0].volatile = {partiallyTrapped: {sourceId: 'player-1', moveName: 'Fire Spin', turns: 3}};
assert.equal(enumerateSwitchActions(ghostMoveTrap).length, 1);
assert.doesNotThrow(() => applySwitchAction(ghostMoveTrap, voluntarySwitch(ghostMoveTrap)));
const genFiveGhostMoveTrap = state({generation: 5, actorSpecies: 'Gastly'});
genFiveGhostMoveTrap.sides.ai.party[0].volatile = {
  partiallyTrapped: {sourceId: 'player-1', moveName: 'Fire Spin', turns: 3},
};
assert.equal(enumerateSwitchActions(genFiveGhostMoveTrap).length, 0);
const ghostNoRetreat = state({actorSpecies: 'Gastly'});
ghostNoRetreat.sides.ai.party[0].volatile = {trapped: {moveName: 'No Retreat'}};
assert.equal(enumerateSwitchActions(ghostNoRetreat).length, 0);
const shedShellNoRetreat = state();
shedShellNoRetreat.sides.ai.party[0].item = 'Shed Shell';
shedShellNoRetreat.sides.ai.party[0].volatile = {trapped: {moveName: 'No Retreat'}};
assert.equal(enumerateSwitchActions(shedShellNoRetreat).length, 0);
const fireSpinGhost = state();
fireSpinGhost.sides.ai.party[0].moves = [{name: 'Fire Spin'}];
fireSpinGhost.sides.player.party[0].species = 'Gastly';
const fireSpinGhostResolution = deriveMoveResolution(fireSpinGhost, {
  kind: 'move', actorId: 'ai-1', moveName: 'Fire Spin', targetIds: ['player-1'],
}, {hit: true, facts: {
  damage: {rolls: [10], min: 10, max: 10, targetHp: 100, possibleKO: false, guaranteedKO: false},
}});
assert.equal(fireSpinGhostResolution.volatileByPokemon?.['player-1']?.partiallyTrapped, undefined);
const ghostMeanLook = state();
ghostMeanLook.sides.ai.party[0].moves = [{name: 'Mean Look'}];
ghostMeanLook.sides.player.party[0].species = 'Gastly';
assert.equal(enumerateMoveActions(ghostMeanLook).some(action => action.moveName === 'Mean Look'), false);
const ghostOctolock = state();
ghostOctolock.sides.ai.party[0].moves = [{name: 'Octolock'}];
ghostOctolock.sides.player.party[0].species = 'Gastly';
assert.equal(enumerateMoveActions(ghostOctolock).some(action => action.moveName === 'Octolock'), false);
const ghostOctolockResolution = deriveMoveResolution(ghostOctolock, {
  kind: 'move', actorId: 'ai-1', moveName: 'Octolock', targetIds: ['player-1'],
}, {hit: true});
assert.equal(ghostOctolockResolution.hit, false);

const trappedPivot = state({holderAbility: 'Arena Trap'});
trappedPivot.sides.ai.party[0].moves = [{name: 'U-turn'}];
const trappedPivotResolution = deriveMoveResolution(trappedPivot, {
  kind: 'move', actorId: 'ai-1', moveName: 'U-turn', targetIds: ['player-1'],
}, {hit: true});
assert.equal(trappedPivotResolution.forcedSwitchByPokemon, undefined);
const airbornePivot = state({holderAbility: 'Arena Trap'});
airbornePivot.sides.ai.party[0].moves = [{name: 'U-turn'}];
airbornePivot.sides.ai.party[0].typeOverride = ['Flying'];
const airbornePivotResolution = deriveMoveResolution(airbornePivot, {
  kind: 'move', actorId: 'ai-1', moveName: 'U-turn', targetIds: ['player-1'],
}, {hit: true});
assert.equal(airbornePivotResolution.forcedSwitchByPokemon?.['ai-1'], true);

const trappedShedTail = state({holderAbility: 'Arena Trap'});
trappedShedTail.sides.ai.party[0].moves = [{name: 'Shed Tail'}];
assert.equal(enumerateMoveActions(trappedShedTail).some(action => action.moveName === 'Shed Tail'), false);
const trappedShedTailResolution = deriveMoveResolution(trappedShedTail, {
  kind: 'move', actorId: 'ai-1', moveName: 'Shed Tail', targetIds: ['ai-1'],
}, {hit: true});
assert.equal(trappedShedTailResolution.hit, false);

const forced = state({holderAbility: 'Arena Trap'});
forced.pendingForcedSwitchIds = ['ai-1'];
const forcedAction = enumerateForcedSwitchActions(forced)[0];
assert.equal(forcedAction?.forced, true);
assert.doesNotThrow(() => applySwitchAction(forced, forcedAction));

const zeroToHero = state({actorSpecies: 'Palafin', actorAbility: 'Zero to Hero'});
const firstZeroToHeroSwitch = applySwitchAction(zeroToHero, voluntarySwitch(zeroToHero));
assert.equal(firstZeroToHeroSwitch.sides.ai.party[0].zeroToHeroTriggered, true);
const returnZeroToHero = applySwitchAction(firstZeroToHeroSwitch, {
  kind: 'switch', actorId: 'ai-2', replacementId: 'ai-1',
});
assert.equal(returnZeroToHero.sides.ai.party[0].speciesOverride, 'Palafin-Hero');

console.log('Switch ability fixtures passed');
