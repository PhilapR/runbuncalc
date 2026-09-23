import assert from 'node:assert/strict';
import {calculateActionFacts} from '../calc-adapter';
import {enumerateMoveActions, getPokemon} from '../actions';
import {deriveMoveResolution} from '../move-engine';
import {BattleState, MoveAction, PokemonState} from '../model';
import {applyAction} from '../transition';

// From Generation VI, powder moves (Spore, Stun Spore, Sleep Powder, Poison
// Powder, Cotton Spore, Magic Powder, Rage Powder, Powder) have no effect on
// Grass types, on Overcoat, or on a holder of Safety Goggles. The engine had
// only Rage Powder's redirection rule, so it offered Stun Spore into Tsareena
// (heldout1-c-pp, "Battle Girl Luna @51", seed 15) and would have applied it.

type Mon = Partial<PokemonState> & {species: string};

function mon(id: string, spec: Mon): PokemonState {
  return {id, level: 50, hp: {current: 150, max: 150}, moves: [{name: 'Tackle'}], ...spec} as PokemonState;
}

function state(attacker: Mon, defenders: Mon[], generation = 8): BattleState {
  const doubles = defenders.length > 1;
  return {
    generation: generation as BattleState['generation'],
    mode: doubles ? 'Doubles' : 'Singles',
    turn: 1,
    field: {},
    sides: {
      ai: {activeIds: ['ai-1'], party: [mon('ai-1', attacker)]},
      player: {
        activeIds: defenders.map((_, index) => `player-${index + 1}`),
        party: defenders.map((defender, index) => mon(`player-${index + 1}`, defender)),
      },
    },
  };
}

function offered(fixture: BattleState, moveName: string): MoveAction | undefined {
  return enumerateMoveActions(fixture, 'ai').find(action => action.moveName === moveName);
}

function use(fixture: BattleState, moveName: string, targetIds = ['player-1']) {
  const action: MoveAction = {kind: 'move', actorId: 'ai-1', moveName, targetIds};
  const resolution = deriveMoveResolution(fixture, action, {hit: true, random: () => 0});
  return {resolution, after: applyAction(fixture, action, resolution)};
}

const user = (moveName: string, extra: Partial<Mon> = {}): Mon =>
  ({species: 'Vileplume', ability: 'Chlorophyll', moves: [{name: moveName}, {name: 'Tackle'}], ...extra});

// Control: a non-immune target takes the status, so the cases below have teeth.
{
  const fixture = state(user('Poison Powder'), [{species: 'Machamp', ability: 'Guts'}]);
  assert.ok(offered(fixture, 'Poison Powder'), 'Poison Powder is offered into a non-immune target');
  const {resolution, after} = use(fixture, 'Poison Powder');
  assert.equal(resolution.hit, true);
  assert.equal(getPokemon(after, 'player-1')?.status, 'psn');
}

// Grass: Tsareena, the receipt's case.
{
  const fixture = state(user('Poison Powder'), [{species: 'Tsareena', ability: 'Queenly Majesty'}]);
  assert.equal(offered(fixture, 'Poison Powder'), undefined, 'Poison Powder is not offered into a Grass type');
  const {resolution, after} = use(fixture, 'Poison Powder');
  assert.equal(resolution.hit, false);
  assert.match(resolution.trace?.notes?.join(' ') || '', /immune to powder moves/);
  assert.equal(getPokemon(after, 'player-1')?.status, undefined, 'a Grass type is not poisoned by Poison Powder');
}

// Grass also blocks Spore and a powder stage drop.
{
  const spore = use(state(user('Spore'), [{species: 'Venusaur', ability: 'Overgrow'}]), 'Spore');
  assert.equal(getPokemon(spore.after, 'player-1')?.status, undefined, 'Spore does not put a Grass type to sleep');
  const cotton = use(state(user('Cotton Spore'), [{species: 'Venusaur', ability: 'Overgrow'}]), 'Cotton Spore');
  assert.equal(getPokemon(cotton.after, 'player-1')?.boosts?.spe || 0, 0, 'Cotton Spore does not lower a Grass type');
}

// Overcoat, and Mold Breaker ignores it.
{
  const overcoat: Mon = {species: 'Forretress', ability: 'Overcoat'};
  const fixture = state(user('Stun Spore'), [overcoat]);
  assert.equal(offered(fixture, 'Stun Spore'), undefined, 'Stun Spore is not offered into Overcoat');
  assert.equal(getPokemon(use(fixture, 'Stun Spore').after, 'player-1')?.status, undefined,
    'Overcoat blocks Stun Spore');
  const breaker = state(user('Stun Spore', {species: 'Excadrill', ability: 'Mold Breaker'}), [overcoat]);
  assert.ok(offered(breaker, 'Stun Spore'), 'Mold Breaker Stun Spore is offered into Overcoat');
  assert.equal(getPokemon(use(breaker, 'Stun Spore').after, 'player-1')?.status, 'par',
    'Mold Breaker ignores Overcoat');
}

// Safety Goggles, while the item is active.
{
  const goggles: Mon = {species: 'Machamp', ability: 'Guts', item: 'Safety Goggles'};
  const fixture = state(user('Sleep Powder'), [goggles]);
  assert.equal(offered(fixture, 'Sleep Powder'), undefined, 'Sleep Powder is not offered into Safety Goggles');
  assert.equal(getPokemon(use(fixture, 'Sleep Powder').after, 'player-1')?.status, undefined,
    'Safety Goggles block Sleep Powder');
  const klutz = state(user('Sleep Powder'), [{...goggles, species: 'Lopunny', ability: 'Klutz'}]);
  assert.equal(getPokemon(use(klutz, 'Sleep Powder').after, 'player-1')?.status, 'slp',
    'Klutz suppresses the goggles');
}

// Doubles: Cotton Spore still lowers the non-immune foe beside a Grass one.
{
  const fixture = state(user('Cotton Spore'), [
    {species: 'Tsareena', ability: 'Queenly Majesty'},
    {species: 'Machamp', ability: 'Guts'},
  ]);
  const action = offered(fixture, 'Cotton Spore');
  assert.ok(action, 'Cotton Spore is offered while one foe can be affected');
  const {after} = use(fixture, 'Cotton Spore', action.targetIds);
  assert.equal(getPokemon(after, 'player-1')?.boosts?.spe || 0, 0, 'the Grass foe keeps its Speed');
  assert.equal(getPokemon(after, 'player-2')?.boosts?.spe, -2, 'the other foe loses two stages');
}

// The user is never immune to its own powder move: a Grass Rage Powder works.
{
  const fixture = state(user('Rage Powder', {species: 'Amoonguss', ability: 'Regenerator'}),
    [{species: 'Machamp', ability: 'Guts'}, {species: 'Machamp', ability: 'Guts'}]);
  const action = offered(fixture, 'Rage Powder');
  assert.ok(action, 'a Grass user can select Rage Powder');
  const {after} = use(fixture, 'Rage Powder', action.targetIds);
  assert.ok(getPokemon(after, 'ai-1')?.volatile?.ragePowder, 'Rage Powder draws attention');
}

// Before Generation VI there is no powder immunity.
{
  const fixture = state(user('Spore'), [{species: 'Venusaur', ability: 'Overgrow'}], 5);
  assert.equal(getPokemon(use(fixture, 'Spore').after, 'player-1')?.status, 'slp',
    'Generation V Spore puts a Grass type to sleep');
}

// Effect Spore is powder too: the same three immunities protect the
// ATTACKER that makes contact. This is the receipt's actual poisoning —
// Tsareena's Knock Off into Effect Spore Parasect. A roll of 0 is a
// certain poison, so the control shows the cases below have teeth.
function contactInto(attacker: Mon, generation = 8) {
  const fixture = state({moves: [{name: 'Tackle'}], ...attacker},
    [{species: 'Parasect', ability: 'Effect Spore', hp: {current: 300, max: 300}}], generation);
  const action: MoveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
  const resolution = deriveMoveResolution(fixture, action,
    {facts: calculateActionFacts(fixture, action), hit: true, random: () => 0});
  return getPokemon(applyAction(fixture, action, resolution), 'ai-1')?.status;
}
assert.equal(contactInto({species: 'Machamp', ability: 'Guts'}), 'psn', 'Effect Spore poisons a non-immune attacker');
assert.equal(contactInto({species: 'Tsareena', ability: 'Queenly Majesty'}), undefined,
  'Effect Spore does not affect a Grass attacker');
assert.equal(contactInto({species: 'Forretress', ability: 'Overcoat'}), undefined,
  'Effect Spore does not affect an Overcoat attacker');
assert.equal(contactInto({species: 'Machamp', ability: 'Guts', item: 'Safety Goggles'}), undefined,
  'Effect Spore does not affect a Safety Goggles attacker');
assert.equal(contactInto({species: 'Lopunny', ability: 'Klutz', item: 'Safety Goggles'}), 'psn',
  'Klutz suppresses the goggles');
assert.equal(contactInto({species: 'Sceptile', ability: 'Overgrow'}, 5), 'psn',
  'Generation V Effect Spore affects a Grass attacker');

console.log('powder immunity: Grass, Overcoat and Safety Goggles block powder moves and Effect Spore from Generation VI');
