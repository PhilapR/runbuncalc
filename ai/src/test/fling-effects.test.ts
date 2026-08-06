import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState} from '../model';
import {applyAction} from '../transition';

function state(item: string, generation = 9): BattleState {
  return {
    generation: generation as BattleState['generation'],
    mode: 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [{
        id: 'ai-1', species: 'Pikachu', level: 100, item,
        hp: {current: 100, max: 100}, moves: [{name: 'Fling', pp: 10, maxPP: 10}],
      }]},
      player: {activeIds: ['player-1'], party: [{
        id: 'player-1', species: 'Mewtwo', level: 100,
        hp: {current: 1000, max: 1000}, moves: [{name: 'Tackle'}],
      }]},
    },
  };
}

function resolve(fixture: BattleState, hit = true) {
  const action = enumerateMoveActions(fixture, 'ai').find(candidate => candidate.moveName === 'Fling');
  assert.ok(action);
  return deriveMoveResolution(fixture, action, {
    facts: calculateActionFacts(fixture, action), hit, random: () => 0,
  });
}

for (const [item, status] of [['Flame Orb', 'brn'], ['Light Ball', 'par'], ['Poison Barb', 'psn'], ['Toxic Orb', 'tox']] as const) {
  const fixture = state(item);
  const resolution = resolve(fixture);
  assert.equal(resolution.statusByPokemon?.['player-1'], status);
  if (status === 'tox') assert.equal(resolution.toxicCounterByPokemon?.['player-1'], 1);
  assert.equal(applyAction(fixture, enumerateMoveActions(fixture, 'ai')[0], resolution)
    .sides.ai.party[0].item, undefined);
}

for (const item of ['King\'s Rock', 'Razor Fang']) {
  const fixture = state(item);
  assert.equal(resolve(fixture).volatileByPokemon?.['player-1']?.flinch?.turns, 1);
}

const oran = state('Oran Berry');
oran.sides.player.party[0].hp.current = 50;
assert.equal(resolve(oran).hpDeltaByPokemon?.['player-1'], 10);

const ripenOran = state('Oran Berry');
ripenOran.sides.player.party[0].ability = 'Ripen';
ripenOran.sides.player.party[0].hp.current = 50;
assert.equal(resolve(ripenOran).hpDeltaByPokemon?.['player-1'], 20);

const fullConfusionBerry = state('Aguav Berry');
assert.equal(resolve(fullConfusionBerry).hpDeltaByPokemon, undefined);

const sitrus = state('Sitrus Berry');
sitrus.sides.player.party[0].hp.current = 50;
assert.equal(resolve(sitrus).hpDeltaByPokemon?.['player-1'], 250);

const lum = state('Lum Berry');
lum.sides.player.party[0].status = 'brn';
lum.sides.player.party[0].volatile = {confusion: {turns: 2}};
const lumResolution = resolve(lum);
assert.equal(lumResolution.statusByPokemon?.['player-1'], '');
assert.equal(lumResolution.volatileByPokemon?.['player-1']?.confusion, null);
const persim = state('Persim Berry');
persim.sides.player.party[0].volatile = {confusion: {turns: 2}};
assert.equal(resolve(persim).volatileByPokemon?.['player-1']?.confusion, null);
for (const [item, status] of [
  ['Cheri Berry', 'par'], ['Chesto Berry', 'slp'], ['Pecha Berry', 'tox'],
  ['Rawst Berry', 'brn'], ['Aspear Berry', 'frz'],
] as const) {
  const statusBerry = state(item);
  statusBerry.sides.player.party[0].status = status;
  if (status === 'tox') statusBerry.sides.player.party[0].toxicCounter = 3;
  const statusBerryResolution = resolve(statusBerry);
  assert.equal(statusBerryResolution.statusByPokemon?.['player-1'], '');
  assert.equal(statusBerryResolution.toxicCounterByPokemon?.['player-1'], 0);
}

const mentalHerbFling = state('Mental Herb');
mentalHerbFling.sides.player.party[0].item = 'Leftovers';
mentalHerbFling.sides.player.party[0].volatile = {
  taunt: {turns: 2}, encore: {turns: 1}, disable: {turns: 3},
};
const mentalHerbFlingResolution = resolve(mentalHerbFling);
assert.equal(mentalHerbFlingResolution.volatileByPokemon?.['player-1']?.taunt, null);
assert.equal(mentalHerbFlingResolution.volatileByPokemon?.['player-1']?.encore, null);
assert.equal(mentalHerbFlingResolution.volatileByPokemon?.['player-1']?.disable, null);
assert.equal(mentalHerbFlingResolution.itemByPokemon?.['player-1'], undefined);
assert.ok(mentalHerbFlingResolution.trace?.notes?.some(note => note.includes('Fling Mental Herb')));

const cloakedMentalHerbFling = state('Mental Herb');
cloakedMentalHerbFling.sides.player.party[0].item = 'Covert Cloak';
cloakedMentalHerbFling.sides.player.party[0].volatile = {taunt: {turns: 2}};
assert.equal(resolve(cloakedMentalHerbFling).volatileByPokemon?.['player-1']?.taunt, null);

const sheerForceMentalHerbFling = state('Mental Herb');
sheerForceMentalHerbFling.sides.ai.party[0].ability = 'Sheer Force';
sheerForceMentalHerbFling.sides.player.party[0].volatile = {taunt: {turns: 2}};
assert.equal(resolve(sheerForceMentalHerbFling).volatileByPokemon?.['player-1']?.taunt, null);

const sheerForceBerryFling = state('Oran Berry');
sheerForceBerryFling.sides.ai.party[0].ability = 'Sheer Force';
sheerForceBerryFling.sides.player.party[0].hp.current = 50;
assert.equal(resolve(sheerForceBerryFling).hpDeltaByPokemon?.['player-1'], 10);

const cloakedBerryFling = state('Oran Berry');
cloakedBerryFling.sides.player.party[0].item = 'Covert Cloak';
cloakedBerryFling.sides.player.party[0].hp.current = 50;
assert.equal(resolve(cloakedBerryFling).hpDeltaByPokemon?.['player-1'], 10);

const actorUnnerveBerryFling = state('Oran Berry');
actorUnnerveBerryFling.sides.ai.party[0].ability = 'Unnerve';
actorUnnerveBerryFling.sides.player.party[0].hp.current = 50;
assert.equal(enumerateMoveActions(actorUnnerveBerryFling, 'ai')
  .some(action => action.moveName === 'Fling'), true);
const actorUnnerveBerryFlingResolution = resolve(actorUnnerveBerryFling);
assert.equal(actorUnnerveBerryFlingResolution.hpDeltaByPokemon, undefined);
assert.equal(actorUnnerveBerryFlingResolution.itemByPokemon?.['ai-1'], null);

const targetUnnerveBerryFling = state('Oran Berry');
targetUnnerveBerryFling.sides.player.party[0].ability = 'Unnerve';
targetUnnerveBerryFling.sides.player.party[0].hp.current = 50;
const targetUnnerveBerryFlingResolution = resolve(targetUnnerveBerryFling);
assert.equal(targetUnnerveBerryFlingResolution.hpDeltaByPokemon?.['player-1'], 10);
assert.equal(targetUnnerveBerryFlingResolution.itemByPokemon?.['ai-1'], null);

const lansat = state('Lansat Berry');
assert.ok(resolve(lansat).volatileByPokemon?.['player-1']?.focusEnergy);

const micle = state('Micle Berry');
assert.equal(resolve(micle).volatileByPokemon?.['player-1']?.micleBerry?.turns, 2);

const kee = state('Kee Berry');
assert.equal(resolve(kee).boostsByPokemon?.['player-1']?.def, 1);

const ripenKee = state('Kee Berry');
ripenKee.sides.player.party[0].ability = 'Ripen';
assert.equal(resolve(ripenKee).boostsByPokemon?.['player-1']?.def, 2);

const maranga = state('Maranga Berry');
assert.equal(resolve(maranga).boostsByPokemon?.['player-1']?.spd, 1);

const starf = state('Starf Berry');
assert.equal(resolve(starf).boostsByPokemon?.['player-1']?.atk, 2);

const ripenStarf = state('Starf Berry');
ripenStarf.sides.player.party[0].ability = 'Ripen';
assert.equal(resolve(ripenStarf).boostsByPokemon?.['player-1']?.atk, 4);

const whiteHerbFling = state('White Herb');
whiteHerbFling.sides.player.party[0].boosts = {atk: -2, def: 1, spe: -1};
const whiteHerbFlingResolution = resolve(whiteHerbFling);
assert.equal(whiteHerbFlingResolution.setBoostsByPokemon?.['player-1']?.atk, 0);
assert.equal(whiteHerbFlingResolution.setBoostsByPokemon?.['player-1']?.spe, 0);
assert.equal(whiteHerbFlingResolution.setBoostsByPokemon?.['player-1']?.def, undefined);

const liechi = state('Liechi Berry');
const liechiResolution = resolve(liechi);
assert.equal(liechiResolution.boostsByPokemon?.['player-1']?.atk, 1);

const leppa = state('Leppa Berry');
leppa.sides.player.party[0].moves = [{name: 'Tackle', pp: 0, maxPP: 35}];
assert.equal(resolve(leppa).movesByPokemon?.['player-1']?.[0]?.pp, 10);

const ripenLeppa = state('Leppa Berry');
ripenLeppa.sides.player.party[0].ability = 'Ripen';
ripenLeppa.sides.player.party[0].moves = [{name: 'Tackle', pp: 0, maxPP: 35}];
assert.equal(resolve(ripenLeppa).movesByPokemon?.['player-1']?.[0]?.pp, 20);

const cheekPouch = state('Oran Berry');
cheekPouch.sides.player.party[0].ability = 'Cheek Pouch';
cheekPouch.sides.player.party[0].hp.current = 50;
assert.equal(resolve(cheekPouch).hpDeltaByPokemon?.['player-1'], 343);

const fireTarget = state('Flame Orb');
fireTarget.sides.player.party[0].species = 'Charizard';
assert.equal(resolve(fireTarget).statusByPokemon, undefined);

const cloaked = state('Flame Orb');
cloaked.sides.player.party[0].item = 'Covert Cloak';
assert.equal(resolve(cloaked).statusByPokemon, undefined);

const sheerForce = state('Flame Orb');
sheerForce.sides.ai.party[0].ability = 'Sheer Force';
assert.equal(resolve(sheerForce).statusByPokemon, undefined);

const innerFocus = state('King\'s Rock');
innerFocus.sides.player.party[0].ability = 'Inner Focus';
assert.equal(resolve(innerFocus).volatileByPokemon, undefined);

const missed = state('Toxic Orb');
assert.equal(resolve(missed, false).statusByPokemon, undefined);
assert.equal(resolve(missed, false).itemByPokemon?.['ai-1'], null);

const preGen4 = state('Flame Orb', 3);
assert.equal(enumerateMoveActions(preGen4, 'ai').some(action => action.moveName === 'Fling'), false);
assert.equal(deriveMoveResolution(preGen4, {
  kind: 'move', actorId: 'ai-1', moveName: 'Fling', targetIds: ['player-1'],
}, {hit: true}).hit, false);

console.log('Fling effect fixtures passed');
