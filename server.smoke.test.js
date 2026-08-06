/* eslint-env node, es6 */

const assert = require('node:assert/strict');
const test = require('node:test');
const serverModule = require('./server');
const startServer = serverModule.startServer;

let server;
let baseUrl;

function state() {
	return {
		generation: 9,
		mode: 'Singles',
		turn: 1,
		field: {},
		sides: {
			ai: {activeIds: ['ai-1'], party: [{
				id: 'ai-1', species: 'Pikachu', level: 100,
				hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}, {name: 'Protect'}],
			}]},
			player: {activeIds: ['player-1'], party: [{
				id: 'player-1', species: 'Rattata', level: 100,
				hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}, {name: 'Thunderbolt'}],
			}]},
		},
	};
}

async function requestJson(path, body) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body: JSON.stringify(body),
	});
	return {status: response.status, body: await response.json()};
}

async function requestRaw(path, body) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body,
	});
	return {status: response.status, body: await response.json()};
}

test.before(async () => {
	server = startServer(0);
	await new Promise(resolve => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('calculator endpoint returns a serialized damage result', async () => {
	const response = await requestJson('/calculate', {
		gen: 9,
		attackingPokemon: 'Pikachu',
		defendingPokemon: 'Rattata',
		moveName: 'Tackle',
	});

	assert.equal(response.status, 200);
	assert.ok(Array.isArray(response.body.damage));
});

test('calculator endpoint rejects invalid input as JSON', async () => {
	const missing = await requestJson('/calculate', {
		gen: 9,
		attackingPokemon: 'Pikachu',
		moveName: 'Tackle',
	});
	assert.equal(missing.status, 400);
	assert.match(missing.body.error, /defendingPokemon/);

	const unknown = await requestJson('/calculate', {
		gen: 9,
		attackingPokemon: 'Not a Pokemon',
		defendingPokemon: 'Rattata',
		moveName: 'Tackle',
	});
	assert.equal(unknown.status, 400);
	assert.match(unknown.body.error, /attackingPokemon/);

	const malformed = await requestRaw('/calculate', '{"gen":9,');
	assert.equal(malformed.status, 400);
	assert.deepEqual(malformed.body, {error: 'request body must contain valid JSON'});
});

test('AI validate-battle-state accepts valid state and rejects invalid payloads', async () => {
	const ok = await requestJson('/ai/validate-battle-state', {state: state()});
	assert.equal(ok.status, 200);
	assert.equal(ok.body.ok, true);

	const missing = await requestJson('/ai/validate-battle-state', {});
	assert.equal(missing.status, 400);
	assert.match(missing.body.error, /BattleState with sides/);

	const invalid = state();
	invalid.sides.ai.party[0].hp.current = -1;
	const bad = await requestJson('/ai/validate-battle-state', {state: invalid});
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /Invalid BattleState|current HP/i);
});

test('AI choice endpoint validates state and returns a legal action', async () => {
	const response = await requestJson('/ai/choose-action', {state: state()});

	assert.equal(response.status, 200);
	assert.equal(response.body.action.kind, 'move');
	assert.ok(Array.isArray(response.body.evaluations));
});

test('AI evaluation endpoint returns scored actions without selecting one', async () => {
	const response = await requestJson('/ai/evaluate-actions', {state: state()});

	assert.equal(response.status, 200);
	assert.ok(Array.isArray(response.body.evaluations));
	assert.ok(response.body.evaluations.length > 0);
	assert.ok(response.body.evaluations.every(evaluation =>
		 evaluation.action && Array.isArray(evaluation.outcomes)));
});

test('AI choice endpoint accepts caller-defined moves without explicit targets', async () => {
	const customState = state();
	customState.sides.ai.party[0].moves = [{
		name: 'Caller Defined Move', basePower: 80, type: 'Fire', category: 'Special',
	}];
	const response = await requestJson('/ai/choose-action', {state: customState});

	assert.equal(response.status, 200);
	assert.equal(response.body.action.moveName, 'Caller Defined Move');
});

test('AI choice endpoint preserves incoming threat facts for player perspective', async () => {
	const playerState = state();
	playerState.sides.player.party[0].hp.current = 1;
	playerState.sides.player.party[0].moves = [{name: 'Calm Mind'}];
	playerState.sides.ai.party[0].moves = [{name: 'Tackle'}];
	const response = await requestJson('/ai/choose-action', {
		state: playerState,
		options: {sideId: 'player'},
	});

	assert.equal(response.status, 200);
	const evaluation = response.body.evaluations.find(candidate =>
		candidate.action.kind === 'move' && candidate.action.actorId === 'player-1' &&
		candidate.action.moveName === 'Calm Mind');
	assert.ok(evaluation);
	assert.equal(evaluation.facts.opponentCanKO, true);
	assert.ok(evaluation.facts.opponentMaxDamage >= 1);
});

test('AI choice endpoint preserves optional voluntary-switch defaults', async () => {
	const switchState = state();
	switchState.sides.ai.party[0].moves = [{name: 'Tackle'}];
	switchState.sides.player.party[0].species = 'Gastly';
	switchState.sides.ai.party.push({
		id: 'ai-2', species: 'Bulbasaur', level: 100,
		hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
	});
	const response = await requestJson('/ai/choose-action', {
		state: switchState,
		options: {
			includeSwitches: true,
			replacementViability: {
				'ai-2': {faster: true, notOHKOd: true, not2HKOd: true},
			},
		},
	});

	assert.equal(response.status, 200);
	const switchEvaluation = response.body.evaluations.find(evaluation => evaluation.action.kind === 'switch');
	assert.deepEqual(switchEvaluation.outcomes, [
		{score: 0, probability: 0.5},
		{score: -20, probability: 0.5},
	]);
});

test('AI end-turn endpoint returns a serializable resolution', async () => {
	const response = await requestJson('/ai/derive-end-turn', {state: state()});

	assert.equal(response.status, 200);
	assert.equal(typeof response.body, 'object');
});

test('remaining AI state endpoints preserve their documented boundary shapes', async () => {
	const moveAction = {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']};
	const derived = await requestJson('/ai/derive-resolution', {
		state: state(), action: moveAction, hit: true,
	});
	assert.equal(derived.status, 200);
	assert.equal(derived.body.hit, true);

	const confusedState = state();
	confusedState.sides.ai.party[0].volatile = {confusion: {turns: 2}};
	const confused = await requestJson('/ai/derive-resolution', {
		state: confusedState,
		action: moveAction,
		hit: true,
		facts: {
			confusionDamage: {
				rolls: [12], min: 12, max: 12, targetHp: 100,
				possibleKO: false, guaranteedKO: false,
			},
		},
	});
	assert.equal(confused.status, 200);

	const truantState = state();
	truantState.sides.ai.party[0].ability = 'Truant';
	const truant = await requestJson('/ai/derive-resolution', {
		state: truantState, action: moveAction, hit: true,
	});
	assert.equal(truant.status, 200);
	assert.deepEqual(truant.body.volatileByPokemon['ai-1'].truant, {});

	const multiHitState = state();
	multiHitState.sides.ai.party[0].species = 'Cloyster';
	multiHitState.sides.ai.party[0].moves = [{name: 'Scale Shot'}];
	multiHitState.sides.player.party[0].species = 'Mewtwo';
	const multiHit = await requestJson('/ai/derive-resolution', {
		state: multiHitState,
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Scale Shot', targetIds: ['player-1']},
		hit: true,
		facts: {
			moveCategory: 'Physical', moveType: 'Rock', moveAccuracy: true, isMultiHit: true,
			damage: {
				rolls: [25], hits: 3, min: 75, max: 75, targetHp: 100,
				possibleKO: false, guaranteedKO: false,
			},
		},
	});
	assert.equal(multiHit.status, 200);
	assert.equal(multiHit.body.hitDamageByTarget['player-1'].length, 3);

	const thunderboltState = state();
	thunderboltState.sides.ai.party[0].moves = [{name: 'Thunderbolt', pp: 15, maxPP: 15}];
	const thunderbolt = await requestJson('/ai/derive-resolution', {
		state: thunderboltState,
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Thunderbolt', targetIds: ['player-1']},
		hit: true,
		facts: {
			moveCategory: 'Special',
			secondaryEffects: [{chance: 10, status: 'par'}],
		},
	});
	assert.equal(thunderbolt.status, 200);
	assert.ok(thunderbolt.body.trace?.secondaryRolls?.['player-1:0'] !== undefined);

	const switchState = state();
	switchState.sides.ai.party.push({
		id: 'ai-2', species: 'Bulbasaur', level: 100,
		hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
	});
	const switchAction = {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'};
	const entry = await requestJson('/ai/derive-switch-entry', {
		state: switchState, action: switchAction,
	});
	assert.equal(entry.status, 200);
	assert.equal(typeof entry.body, 'object');

	const forcedState = state();
	forcedState.sides.ai.party[0].hp.current = 0;
	forcedState.sides.ai.party.push({
		id: 'ai-2', species: 'Bulbasaur', level: 100,
		hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
	});
	const forced = await requestJson('/ai/forced-switch-actions', {state: forcedState});
	assert.equal(forced.status, 200);
	assert.equal(forced.body.actions[0].forced, true);

	const applied = await requestJson('/ai/apply-action', {
		state: state(), action: moveAction, resolution: {hit: true, damageByTarget: {'player-1': 20}},
	});
	assert.equal(applied.status, 200);
	assert.equal(applied.body.sides.player.party[0].hp.current, 80);

	const ordered = await requestJson('/ai/order-actions', {state: state(), actions: [moveAction]});
	assert.equal(ordered.status, 200);
	assert.deepEqual(ordered.body.actions, [moveAction]);
	const fallbackOrdered = await requestJson('/ai/order-actions', {
		state: state(),
		actions: [{kind: 'move', actorId: 'ai-1', moveName: 'Electro Shot', targetIds: ['player-1']}],
	});
	assert.equal(fallbackOrdered.status, 200);

	const advanced = await requestJson('/ai/advance-turn', {state: state()});
	assert.equal(advanced.status, 200);
	assert.equal(advanced.body.turn, 2);
});

test('AI action endpoints reject malformed action contracts as JSON 400s', async () => {
	const invalidKind = await requestJson('/ai/derive-resolution', {
		state: state(), action: {kind: 'not-a-move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
	});
	assert.equal(invalidKind.status, 400);
	assert.match(invalidKind.body.error, /^Invalid Action:/);
	assert.match(invalidKind.body.error, /action.kind/);

	const invalidChoiceSide = await requestJson('/ai/choose-action', {
		state: state(), options: {sideId: 'spectator'},
	});
	assert.equal(invalidChoiceSide.status, 400);
	assert.match(invalidChoiceSide.body.error, /sideId/);

	const invalidChoiceOptions = await requestJson('/ai/choose-action', {
		state: state(), options: {viableReplacementIds: 'ai-1'},
	});
	assert.equal(invalidChoiceOptions.status, 400);
	assert.match(invalidChoiceOptions.body.error, /viableReplacementIds/);

	const invalidReplacementScore = await requestJson('/ai/choose-action', {
		state: state(), options: {replacementScores: {'ai-1': 'best'}},
	});
	assert.equal(invalidReplacementScore.status, 400);
	assert.match(invalidReplacementScore.body.error, /replacementScores/);

	const invalidForcedSide = await requestJson('/ai/forced-switch-actions', {
		state: state(), sideId: 'spectator',
	});
	assert.equal(invalidForcedSide.status, 400);
	assert.match(invalidForcedSide.body.error, /sideId/);

	const invalidTarget = await requestJson('/ai/apply-action', {
		state: state(), action: {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['missing']},
	});
	assert.equal(invalidTarget.status, 400);
	assert.match(invalidTarget.body.error, /^Invalid Action:/);
	assert.match(invalidTarget.body.error, /target/);

	const invalidBatch = await requestJson('/ai/order-actions', {
		state: state(), actions: [{kind: 'switch', actorId: 'ai-1', replacementId: 'missing'}],
	});
	assert.equal(invalidBatch.status, 400);
	assert.match(invalidBatch.body.error, /^Invalid Action:/);
	assert.match(invalidBatch.body.error, /replacementId/);

	const invalidMoveState = state();
	invalidMoveState.sides.ai.party[0].moves[0].accuracy = 'not-a-number';
	const invalidState = await requestJson('/ai/choose-action', {state: invalidMoveState});
	assert.equal(invalidState.status, 400);
	assert.match(invalidState.body.error, /accuracy/);

	const invalidTargetState = state();
	invalidTargetState.sides.ai.party[0].moves[0].target = 'not-a-target';
	const invalidTargetStateResponse = await requestJson('/ai/choose-action', {state: invalidTargetState});
	assert.equal(invalidTargetStateResponse.status, 400);
	assert.match(invalidTargetStateResponse.body.error, /target/);

	const invalidMoveFlagState = state();
	invalidMoveFlagState.sides.ai.party[0].moves[0].sound = 'yes';
	const invalidMoveFlag = await requestJson('/ai/choose-action', {state: invalidMoveFlagState});
	assert.equal(invalidMoveFlag.status, 400);
	assert.match(invalidMoveFlag.body.error, /sound/);

	const invalidIvState = state();
	invalidIvState.sides.ai.party[0].ivs = {atk: 32};
	const invalidIv = await requestJson('/ai/choose-action', {state: invalidIvState});
	assert.equal(invalidIv.status, 400);
	assert.match(invalidIv.body.error, /IVs/);

	const invalidBasePowerState = state();
	invalidBasePowerState.sides.ai.party[0].moves[0].basePower = -1;
	const invalidBasePower = await requestJson('/ai/choose-action', {state: invalidBasePowerState});
	assert.equal(invalidBasePower.status, 400);
	assert.match(invalidBasePower.body.error, /base power/);

	const invalidResolution = await requestJson('/ai/apply-action', {
		state: state(),
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
		resolution: {hit: true, hpDeltaByPokemon: {'player-1': 'twenty'}},
	});
	assert.equal(invalidResolution.status, 400);
	assert.match(invalidResolution.body.error, /hpDeltaByPokemon/);

	const missingResolution = await requestJson('/ai/apply-action', {
		state: state(),
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
	});
	assert.equal(missingResolution.status, 400);
	assert.match(missingResolution.body.error, /require a resolution/);

	const switchWithResolutionState = state();
	switchWithResolutionState.sides.ai.party.push({
		id: 'ai-2', species: 'Bulbasaur', level: 100,
		hp: {current: 100, max: 100}, moves: [{name: 'Tackle'}],
	});
	const switchWithResolution = await requestJson('/ai/apply-action', {
		state: switchWithResolutionState,
		action: {kind: 'switch', actorId: 'ai-1', replacementId: 'ai-2'},
		resolution: {hit: true},
	});
	assert.equal(switchWithResolution.status, 400);
	assert.match(switchWithResolution.body.error, /do not accept/);

	const invalidDamageTarget = await requestJson('/ai/apply-action', {
		state: state(),
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
		resolution: {hit: true, damageByTarget: {'ai-1': 20}},
	});
	assert.equal(invalidDamageTarget.status, 400);
	assert.match(invalidDamageTarget.body.error, /not a target/);

	const invalidFacts = await requestJson('/ai/derive-resolution', {
		state: state(),
		action: {kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']},
		facts: {attackerSpeed: 'fast'},
	});
	assert.equal(invalidFacts.status, 400);
	assert.match(invalidFacts.body.error, /attackerSpeed/);

	const invalidItemRolls = await requestJson('/ai/order-actions', {
		state: state(), actions: [{kind: 'move', actorId: 'ai-1', moveName: 'Tackle', targetIds: ['player-1']}],
		itemRollsByPokemon: {'ai-1': 1},
	});
	assert.equal(invalidItemRolls.status, 400);
	assert.match(invalidItemRolls.body.error, /itemRollsByPokemon/);
});

test('Doubles evaluate exposes per-actor targets and supports apply → advance', async () => {
	const fixtureResponse = await fetch(`${baseUrl}/fixtures/ui/doubles-sample.json`);
	assert.equal(fixtureResponse.status, 200);
	const doubles = await fixtureResponse.json();
	assert.equal(doubles.mode, 'Doubles');

	const validated = await requestJson('/ai/validate-battle-state', {state: doubles});
	assert.equal(validated.status, 200);

	const evaluated = await requestJson('/ai/evaluate-actions', {
		state: doubles,
		options: {sideId: 'ai'},
	});
	assert.equal(evaluated.status, 200);
	const evaluations = evaluated.body.evaluations;
	assert.ok(Array.isArray(evaluations));
	assert.ok(evaluations.length > 0);

	const actors = new Set(evaluations.map(entry => entry.action.actorId));
	assert.ok(actors.has('ai-1'));
	assert.ok(actors.has('ai-2'));

	const thunderbolts = evaluations.filter(entry =>
		entry.action.kind === 'move' &&
		entry.action.actorId === 'ai-1' &&
		entry.action.moveName === 'Thunderbolt');
	assert.equal(thunderbolts.length, 2);
	const thunderTargets = new Set(thunderbolts.flatMap(entry => entry.action.targetIds));
	assert.deepEqual([...thunderTargets].sort(), ['player-1', 'player-2']);

	const helpingHand = evaluations.find(entry =>
		entry.action.kind === 'move' &&
		entry.action.actorId === 'ai-1' &&
		entry.action.moveName === 'Helping Hand');
	assert.ok(helpingHand);
	assert.deepEqual(helpingHand.action.targetIds, ['ai-2']);

	const gleam = evaluations.find(entry =>
		entry.action.kind === 'move' &&
		entry.action.actorId === 'ai-2' &&
		entry.action.moveName === 'Dazzling Gleam');
	assert.ok(gleam);
	assert.deepEqual([...gleam.action.targetIds].sort(), ['player-1', 'player-2']);

	const action = thunderbolts.find(entry =>
		entry.action.targetIds.length === 1 &&
		entry.action.targetIds[0] === 'player-1').action;
	const derived = await requestJson('/ai/derive-resolution', {state: doubles, action});
	assert.equal(derived.status, 200);
	const applied = await requestJson('/ai/apply-action', {
		state: doubles,
		action,
		resolution: derived.body,
	});
	assert.equal(applied.status, 200);
	assert.equal(applied.body.mode, 'Doubles');
	const advanced = await requestJson('/ai/advance-turn', {state: applied.body});
	assert.equal(advanced.status, 200);
	assert.equal(advanced.body.mode, 'Doubles');
	assert.ok(advanced.body.turn > doubles.turn);
});

test('UI fixture browser assets are served under /fixtures/ui', async () => {
	const manifestResponse = await fetch(`${baseUrl}/fixtures/ui/manifest.json`);
	assert.equal(manifestResponse.status, 200);
	const manifest = await manifestResponse.json();
	assert.ok(Array.isArray(manifest.scenarios));
	assert.ok(manifest.scenarios.length >= 8);

	const sample = manifest.scenarios.find(entry => entry.id === 'sample');
	assert.ok(sample);
	const stateResponse = await fetch(`${baseUrl}/fixtures/ui/${sample.file}`);
	assert.equal(stateResponse.status, 200);
	const battleState = await stateResponse.json();
	assert.equal(battleState.generation, 8);
	assert.ok(battleState.sides);

	const validate = await requestJson('/ai/validate-battle-state', {state: battleState});
	assert.equal(validate.status, 200);
	assert.equal(validate.body.ok, true);

	assert.ok(sample.golden);
	const goldenResponse = await fetch(`${baseUrl}/fixtures/ui/${sample.golden}`);
	assert.equal(goldenResponse.status, 200);
	const golden = await goldenResponse.json();
	assert.equal(golden.kind, 'evaluate-actions');
	assert.ok(Array.isArray(golden.evaluations));
});
