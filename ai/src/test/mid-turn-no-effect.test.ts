import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

// A move chosen at the start of a turn can lose its effect before it
// resolves: the faster action puts the target to sleep, or swaps in an
// immune body. The game uses the move and it fails, PP spent. The engine
// used to refuse it as illegal — its legality gate was the list of moves
// WORTH offering, which drops "would have no effect" — and the driver turned
// each refusal into a lost turn (164 in the 2026-09-18 re-measure).

function state(): BattleState {
  return {
    generation: 8,
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Pikachu', level: 50,
        hp: {current: 100, max: 100}, moves: [{name: 'Thunder Wave', pp: 20, maxPP: 20}, {name: 'Tackle'}],
      }]},
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Gothitelle', level: 50,
        hp: {current: 100, max: 100}, moves: [{name: 'Rest'}],
      }]},
    },
  };
}

const start = state();
const thunderWave = enumerateMoveActions(start, 'player').find(action => action.moveName === 'Thunder Wave');
assert.ok(thunderWave, 'offered at the start of the turn: the target is awake');

// The faster action lands first: the target is asleep when ours resolves.
const asleep: BattleState = JSON.parse(JSON.stringify(start));
asleep.sides.ai.party[0].status = 'slp';
assert.ok(!enumerateMoveActions(asleep, 'player').some(action => action.moveName === 'Thunder Wave'),
  'no longer offered: it would have no effect');

const resolution = deriveMoveResolution(asleep, thunderWave, {
  facts: calculateActionFacts(asleep, thunderWave), hit: true, random: () => 0,
});
const after = applyAction(asleep, thunderWave, resolution);
assert.equal(after.sides.ai.party[0].status, 'slp', 'used and failed: the sleeping target is not paralysed');
assert.equal(after.sides.player.party[0].moves[0].pp, 19, 'and the PP is spent, as the game spends it');

// Throat Chop landing before a queued sound move is used and fails, not refused
// (AI_DATA_MODEL: sound moves "fail at direct-resolution boundaries"). Until
// 2026-09-23 this fixture asserted a refusal, standing in for "the new check
// still applies canUseMove"; frontier Archie's refused Hyper Voice showed the
// refusal made a turn up and voided a batch. The stand-in is now a rule that
// is illegal mid-turn: a body locked into a rampage cannot choose another move.
const withGrowl: BattleState = JSON.parse(JSON.stringify(start));
withGrowl.sides.player.party[0].moves[1] = {name: 'Growl', pp: 40, maxPP: 40};
const growl = enumerateMoveActions(withGrowl, 'player').find(action => action.moveName === 'Growl');
assert.ok(growl, 'Growl is offered while the throat is clear');
const chopped: BattleState = JSON.parse(JSON.stringify(withGrowl));
chopped.sides.player.party[0].volatile = {throatChop: {turns: 2}} as never;
assert.equal(enumerateMoveActions(chopped, 'player').some(action => action.moveName === 'Growl'), false,
  'not offered under Throat Chop');
const choppedResolution = deriveMoveResolution(chopped, growl, {
  facts: calculateActionFacts(chopped, growl), hit: true, random: () => 0,
});
assert.equal(choppedResolution.hit, false, 'queued before the chop: used, and blocked');
applyAction(chopped, growl, choppedResolution);
const locked: BattleState = JSON.parse(JSON.stringify(withGrowl));
locked.sides.player.party[0].volatile = {rampage: {moveName: withGrowl.sides.player.party[0].moves[0].name, turns: 2}} as never;
assert.throws(() => applyAction(locked, growl, deriveMoveResolution(locked, growl, {
  facts: calculateActionFacts(locked, growl), hit: true, random: () => 0,
})), /Move action is not legal in this battle state/);

console.log('Mid-turn no-effect fixtures passed');
