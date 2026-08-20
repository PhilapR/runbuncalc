/* eslint-env node, es6 */

const assert = require('node:assert/strict');
const test = require('node:test');
const serverModule = require('../lib/server');
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

async function getJson(path) {
	const response = await fetch(`${baseUrl}${path}`);
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

test('Replay sample trace is served and each frame validates over HTTP', async () => {
	const response = await fetch(`${baseUrl}/fixtures/ui/replays/sample.json`);
	assert.equal(response.status, 200);
	const replay = await response.json();
	assert.equal(replay.kind, 'apply-advance-trace');
	assert.equal(replay.schemaVersion, 1);
	assert.ok(Array.isArray(replay.steps));
	assert.ok(replay.steps.length >= 2);

	const initial = await requestJson('/ai/validate-battle-state', {state: replay.initialState});
	assert.equal(initial.status, 200);

	for (let i = 0; i < replay.steps.length; i++) {
		const step = replay.steps[i];
		const validated = await requestJson('/ai/validate-battle-state', {state: step.stateAfter});
		assert.equal(validated.status, 200, 'steps[' + i + '].stateAfter');
		if (step.type === 'apply') {
			assert.ok(step.action);
			assert.ok(step.resolution, 'stored resolution avoids re-derive');
			const applied = await requestJson('/ai/apply-action', {
				state: i === 0 ? replay.initialState : replay.steps[i - 1].stateAfter,
				action: step.action,
				resolution: step.resolution,
			});
			assert.equal(applied.status, 200, 'replayed apply steps[' + i + ']');
		}
	}

	const bad = await requestJson('/ai/validate-battle-state', {state: {generation: 8}});
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /BattleState|sides/i);
});

test('planner lists the run map and carries its coverage caveat', async () => {
	const {status, body} = await getJson('/planner/fights');
	assert.equal(status, 200);
	assert.equal(body.fights.length, 362);
	// The caveat travels with the list. A client that only reads `fights` would
	// otherwise present a progression spine as a complete trainer census.
	assert.equal(body.coverage.completeTrainerCensus, false);
	assert.ok(body.coverage.coversMandatoryProgression);
	assert.equal(body.fights[0].trainer, 'Youngster Calvin');
});

test('planner reports what is next from a point in the run', async () => {
	const {status, body} = await getJson('/planner/upcoming?after=0&count=3');
	assert.equal(status, 200);
	assert.equal(body.fights.length, 3);
	assert.equal(body.fights[0].trainer, 'Bug Catcher Rick');
	for (const fight of body.fights) assert.ok(fight.order > 0);
});

test('planner rejects a bad count rather than clamping it silently', async () => {
	const {status, body} = await getJson('/planner/upcoming?count=999');
	assert.equal(status, 400);
	assert.match(body.error, /count must be an integer/);
});

test('an unknown trainer is a client error and suggests the real name', async () => {
	const {status, body} = await getJson('/planner/fight?trainer=Calvin');
	assert.equal(status, 400);
	assert.equal(body.code, 'UnknownTrainer');
	assert.match(body.error, /did you mean.*Youngster Calvin/s);
});

test('planner predicts an opponent turn with ranked actions and a margin', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Youngster Calvin',
		playerParty: [{species: 'Azumarill', setLabel: 'Leader Norman'}],
	});
	assert.equal(status, 200);
	assert.equal(body.trainer, 'Youngster Calvin');
	assert.ok(body.actions.length > 1);
	for (let i = 1; i < body.actions.length; i++) {
		assert.ok(body.actions[i - 1].score >= body.actions[i].score, 'actions must be ranked');
	}
	for (const action of body.actions) {
		assert.ok(action.label && !/undefined/.test(action.label), `unresolved label: ${action.label}`);
	}
	assert.ok(['decided', 'contested', 'only-option'].includes(body.confidence));
	// The position is large and rarely wanted; it is opt-in.
	assert.equal(body.state, undefined);
});

test('planner returns the position only when asked', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Youngster Calvin',
		playerParty: [{species: 'Azumarill', setLabel: 'Leader Norman'}],
		includeState: true,
	});
	assert.equal(status, 200);
	assert.equal(body.state.generation, 8);
	assert.equal(body.state.sides.ai.party.length, 3);
});

test('planning without a team is a 400, not a guess', async () => {
	const {status, body} = await requestJson('/planner/predict', {trainer: 'Youngster Calvin'});
	assert.equal(status, 400);
	assert.match(body.error, /playerParty is required/);
});

test('an unknown set is a client error rather than a 500', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Youngster Calvin',
		playerParty: [{species: 'Azumarill', setLabel: 'Not A Real Set'}],
	});
	assert.equal(status, 400);
	assert.equal(body.code, 'InvalidPlannerRequest');
	assert.match(body.error, /Unknown set/);
});

const PLAYER_PASTE = [
	'Swampert @ Leftovers',
	'Ability: Torrent',
	'Level: 45',
	'Adamant Nature',
	'- Earthquake',
	'- Waterfall',
].join('\n');

test('a Showdown paste is a first-class way to name the player team', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerPaste: PLAYER_PASTE,
		includeState: true,
	});
	assert.equal(status, 200);
	const mon = body.state.sides.player.party[0];
	assert.equal(mon.species, 'Swampert');
	assert.equal(mon.level, 45);
	assert.equal(mon.item, 'Leftovers');
	// The player declared this box, so nothing was borrowed.
	assert.equal(body.borrowedPlayerBuild, false);
	assert.deepEqual(body.notes, []);
});

test('a borrowed trainer build is reported as such on every prediction', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerParty: [{species: 'Metagross', setLabel: 'Trainer Steven Space Center'}],
	});
	assert.equal(status, 200);
	// Steven's level 89 Metagross is not a box any player holds, and the AI scores
	// against it. A client that cannot tell will present it as a plan.
	assert.equal(body.borrowedPlayerBuild, true);
});

test('a double battle says over HTTP that it was ranked as a Singles exchange', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'School Kid Jerry & Johnson',
		playerPaste: PLAYER_PASTE,
	});
	assert.equal(status, 200);
	// The flag exists in the library; a client that never receives it presents a
	// 1v1 ranking of a 2v2 fight with no caveat attached.
	assert.equal(body.plannedAsSingles, true);
	const single = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerPaste: PLAYER_PASTE,
	});
	assert.equal(single.body.plannedAsSingles, false);
});

test('a paste and a party at once is refused rather than silently preferred', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerPaste: PLAYER_PASTE,
		playerParty: [{species: 'Azumarill', setLabel: 'Leader Norman'}],
	});
	assert.equal(status, 400);
	assert.match(body.error, /not both/);
});

test('an unreadable paste is a 400 naming the line, not a 500', async () => {
	const {status, body} = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerPaste: 'Swampertt\n- Earthquake',
	});
	assert.equal(status, 400);
	assert.equal(body.code, 'InvalidPlannerRequest');
	assert.match(body.error, /Pokemon 1 \(Swampertt\): unknown species/);

	const move = await requestJson('/planner/predict', {
		trainer: 'Leader Norman',
		playerPaste: 'Swampert\n- Earthquak',
	});
	assert.equal(move.status, 400);
	assert.match(move.body.error, /unknown move "Earthquak"/);
});

// ------------------------------------------------------------------- the run
//
// The run endpoints are stateless: the playthrough travels in the request and
// the server stores nothing. These cases defend that contract as much as the
// behaviour — a server that started remembering runs would need accounts, and
// nothing here has them.

const OWNED_IVS = {hp: 17, atk: 18, def: 19, spa: 20, spd: 21, spe: 22};

function ownedCatch(command) {
	return Object.assign({}, command, {ivs: Object.assign({}, OWNED_IVS, command.ivs || {})});
}

const RUN_CATCH = ownedCatch(
	{kind: 'catch', species: 'Lillipup', map: 'Route101', level: 3});

async function newRun(body) {
	const {status, body: payload} = await requestJson('/run/new', body || {});
	assert.equal(status, 200);
	return payload.run;
}

test('a run is created, advanced and summarized entirely through the request', async () => {
	const created = await newRun({name: 'HTTP', levelCap: 'next-milestone-ace'});
	assert.equal(created.name, 'HTTP');
	assert.equal(created.position, -1);

	const caught = await requestJson('/run/apply', {run: created, command: RUN_CATCH});
	assert.equal(caught.status, 200);
	assert.match(caught.body.summary, /caught Lillipup at level 3 on Route101/);
	assert.equal(caught.body.status.boxed, 1);
	// The level cap is derived from the run map and names the fight that sets
	// it — the next story boss of any tier, not the next badge.
	assert.equal(caught.body.status.levelCap.trainer, 'Team Aqua Grunt Petalburg Woods');
	assert.equal(caught.body.status.levelCap.cap, 12);
	assert.equal(caught.body.status.split.boss, 'Leader Brawly');

	// The original run is untouched: the server returned a new document rather
	// than mutating anything it was given.
	assert.equal(created.box.length, 0);

	const status = await requestJson('/run/status', {run: caught.body.run});
	assert.equal(status.status, 200);
	assert.equal(status.body.box.length, 1);
	assert.equal(status.body.upcoming[0].trainer, 'Youngster Calvin');
	assert.equal(status.body.opportunities.before.trainer, 'Youngster Calvin');
	// Five: Route 101/102/103 plus Littleroot Town and Oldale Town, which the
	// R&B tracker dated. Petalburg City dropped out — reachable only through
	// Route 102. Both corrections are Philip's, from play.
	assert.equal(status.body.opportunities.encounters.count, 5);
	assert.deepEqual(status.body.opportunities.items.pickups.map(item => item.name),
		['Potion', 'Oran Berry']);
	assert.equal(status.body.opportunities.moves.status, 'dated');
	assert.equal(status.body.opportunities.moves.count, 0,
		'no TM or tutor is reachable before the first fight');

	// The story spine travels with every status, and how far ahead to look is
	// the client's call, bounded.
	assert.equal(status.body.milestones.length, 44);
	assert.equal(status.body.milestones[0].trainer, 'Leader Brawly');
	assert.equal(status.body.milestones[0].beaten, false);
	const wide = await requestJson('/run/status', {run: caught.body.run, upcomingCount: 8});
	assert.equal(wide.body.upcoming.length, 8);
	const clamped = await requestJson('/run/status', {run: caught.body.run, upcomingCount: 999});
	assert.equal(clamped.body.upcoming.length, 20);
});

test('the split sheet travels with status and answers on its own endpoint', async () => {
	const created = await newRun({name: 'Sheet', rival: 'Swampert'});
	const status = await requestJson('/run/status', {run: created});
	assert.equal(status.status, 200);
	assert.equal(status.body.splitPrep.split.boss, 'Leader Brawly');
	assert.equal(status.body.splitPrep.gauntlet.length, 4);

	const sheet = await requestJson('/run/split', {run: created});
	assert.equal(sheet.status, 200);
	assert.equal(sheet.body.split.index, 1);
	assert.equal(sheet.body.gauntlet[3].trainer, 'Leader Brawly');
	assert.equal(sheet.body.gauntlet[3].cap, 21);
});

test('audit regressions: the new endpoints refuse with reasons, never 500', async () => {
	// A mistyped trainer in the faint epitaph is the most likely user mistake
	// on that control; it must come back as the crafted message, not a 500.
	const created = await newRun({name: 'Refusals', permadeath: true});
	const caught = await requestJson('/run/apply', {run: created, command: RUN_CATCH});
	const badFaint = await requestJson('/run/apply', {
		run: caught.body.run, command: {kind: 'faint', id: 'mon-1', to: 'Calvin'},
	});
	assert.equal(badFaint.status, 400);
	assert.match(badFaint.body.error, /no fight named "Calvin"/);

	// A typo'd held item surfaces as a 400 naming the mon, not a dead board.
	const held = await requestJson('/run/apply', {
		run: caught.body.run,
		command: ownedCatch(
			{kind: 'catch', species: 'Marill', map: 'Route114', level: 40, item: 'Lefovers'}),
	});
	assert.equal(held.status, 200);
	const matrix = await requestJson('/run/matrix', {run: held.body.run, trainer: 'Leader Brawly'});
	assert.equal(matrix.status, 400);
	assert.match(matrix.body.error, /Marill .*Lefovers.* is not an item/);

	// A finished run map is an ordinary state: the matrix says so with a 400
	// reason, exactly like /run/plan, rather than a 500.
	let done = caught.body.run;
	done = (await requestJson('/run/apply', {run: done, command: {kind: 'party', ids: ['mon-1']}})).body.run;
	done = (await requestJson('/run/apply', {run: done, command: {kind: 'beat', trainer: 'Champion Wallace'}})).body.run;
	const after = await requestJson('/run/matrix', {run: done});
	assert.equal(after.status, 400);
	assert.match(after.body.error, /nothing ahead/);
	const plan = await requestJson('/run/plan', {run: done});
	assert.equal(plan.status, 400);
});

test('the ranker answers over HTTP, and refuses what it cannot rank', async () => {
	const created = await newRun({name: 'Rank'});
	const caught = await requestJson('/run/apply', {run: created, command: RUN_CATCH});
	const {status, body} = await requestJson('/run/rank', {run: caught.body.run});
	assert.equal(status, 200);
	assert.equal(body.trainer, 'Youngster Calvin');
	assert.equal(body.parties[0].label, 'top');
	assert.ok(body.caveats.length >= 2);

	// An empty box is a 400 with the reason, exactly like the matrix.
	const empty = await requestJson('/run/rank', {run: created});
	assert.equal(empty.status, 400);
	assert.match(empty.body.error, /catch something first/);
});

test('the catch advisor answers over HTTP with the reachable prospects', async () => {
	const created = await newRun({name: 'Scout', permadeath: true});
	const {status, body} = await requestJson('/run/scout', {run: created});
	assert.equal(status, 200);
	assert.equal(body.trainer, 'Leader Brawly');
	assert.ok(body.routesOpen >= 4);
	assert.ok(body.gated >= 1, 'pre-Surf water is gated, not proposed');
	assert.ok(body.catches.every(c => c.method !== 'surf'));

	// A finished target is a 400 with the reason, like every advisor.
	const unknown = await requestJson('/run/scout', {run: created, trainer: 'Nobody'});
	assert.equal(unknown.status, 400);
});

test('the routes view answers over HTTP with the spent and the still-open', async () => {
	const created = await newRun({name: 'Routes', permadeath: true});
	const caught = await requestJson('/run/apply', {run: created, command: RUN_CATCH});
	const {status, body} = await requestJson('/run/routes', {run: caught.body.run});
	assert.equal(status, 200);
	// One row per LOCATION, not per wild table: Granite Cave's floors, Mt
	// Pyre's nine maps and both underwater routes fold into their locations.
	assert.ok(body.routes.length > 60 && body.routes.length < 100,
		'every location answers, grouped by the route rule\'s unit');
	const spent = body.routes.find(route => route.name === 'Route101');
	assert.equal(spent.used.species, 'Lillipup');
	assert.ok(spent.best.length > 0 && spent.best[0].chance > 0);
});

test('a late-game run document still fits through the request body', async () => {
	// Every /run/* command posts the whole save, and a full playthrough's log
	// projects past express.json's stock 100kb limit — which would turn the run
	// panel into HTTP 413s exactly when a run is furthest along and most worth
	// keeping. Inflate a real run's log past that line and expect a real answer.
	const good = await newRun({name: 'Marathon'});
	const entry = {
		at: '2026-08-11T00:00:00.000Z',
		command: {kind: 'nickname', id: 'mon-1', name: 'a mid-run annotation of realistic length'},
	};
	const big = {...good, log: Array.from({length: 2000}, () => entry)};
	assert.ok(Buffer.byteLength(JSON.stringify(big)) > 150 * 1024, 'probe must exceed the stock limit');
	const {status} = await requestJson('/run/status', {run: big});
	assert.equal(status, 200, 'a long-running save must not be refused for its size');
});

test('a command that could not have happened is a 400 with the reason', async () => {
	const created = await newRun();
	const refused = await requestJson('/run/apply', {
		run: created,
		command: {kind: 'catch', species: 'Ralts', map: 'Route101', level: 3},
	});
	assert.equal(refused.status, 400);
	assert.equal(refused.body.code, 'InvalidRunCommand');
	// The message is the feature: it names the route's actual roster.
	assert.match(refused.body.error, /Ralts does not appear on Route101; it holds: Lillipup/);

	const illegal = await requestJson('/run/apply', {
		run: created,
		command: {kind: 'teach', id: 'mon-1', move: 'Dragon Dance'},
	});
	assert.equal(illegal.status, 400);
	assert.match(illegal.body.error, /no Pokemon with id "mon-1"/);
});

test('a run of the wrong version is refused rather than half-read', async () => {
	const missing = await requestJson('/run/apply', {command: RUN_CATCH});
	assert.equal(missing.status, 400);
	assert.equal(missing.body.code, 'InvalidRun');

	const stale = await requestJson('/run/apply', {run: {version: 99}, command: RUN_CATCH});
	assert.equal(stale.status, 400);
	assert.equal(stale.body.code, 'RunVersionMismatch');
	assert.match(stale.body.error, /version 99; this server reads version \d+/);
});

test('a run of the right version but the wrong shape is a 400 naming the field', async () => {
	// The run layer reads these fields without re-checking them, so a document
	// that only carries the version stamp used to reach summarize and 500. Every
	// endpoint inherits this check, and /run/status is where it first bit.
	const good = await newRun();
	const shapes = [
		[{...good, rules: undefined}, /rules/],
		[{...good, rules: 'strict'}, /rules/],
		[{...good, rules: []}, /rules/],
		[{...good, rules: {}}, /levelCap/],
		[{...good, box: {}}, /box/],
		[{...good, log: 'nothing yet'}, /log/],
		[{...good, party: {}}, /party/],
		[{...good, party: [{id: 'mon-1'}]}, /party/],
		// Well-typed but dangling: a party id no box entry carries used to
		// null-deref in summarize and 500.
		[{...good, party: ['mon-999']}, /mon-999.*not in run\.box/],
		[{...good, bag: []}, /bag/],
		[{...good, position: 'start'}, /position/],
		[{...good, nextId: null}, /nextId/],
	];
	for (const [run, field] of shapes) {
		const {status, body} = await requestJson('/run/status', {run});
		assert.equal(status, 400, `malformed run must not 500: ${JSON.stringify(run).slice(0, 80)}`);
		assert.equal(body.code, 'InvalidRun');
		assert.match(body.error, field);
	}

	// The panel's import box accepts pasted JSON, and this is what a curious
	// player types into it first.
	const bare = await requestJson('/run/status', {run: {version: 1}});
	assert.equal(bare.status, 400);
	assert.equal(bare.body.code, 'InvalidRun');

	// The gate admits a real run untouched; a shape check that refuses those
	// would pass every case above and still be broken.
	const ok = await requestJson('/run/status', {run: good});
	assert.equal(ok.status, 200);
	assert.equal(ok.body.status.name, good.name);
});

test('the run plans the next fight with its own party, never a borrowed build', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply', {run, command: RUN_CATCH})).body.run;
	run = (await requestJson('/run/apply', {run, command: {kind: 'party', ids: ['mon-1']}})).body.run;

	const plan = await requestJson('/run/plan', {run});
	assert.equal(plan.status, 200);
	assert.equal(plan.body.trainer, 'Youngster Calvin');
	assert.equal(plan.body.borrowedPlayerBuild, false);
	assert.ok(plan.body.actions.length > 1);

	const empty = await requestJson('/run/plan', {run: await newRun()});
	assert.equal(empty.status, 400);
	assert.match(empty.body.error, /the party is empty/);
});

test('the encounter table marks what the run already holds', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply', {run, command: RUN_CATCH})).body.run;

	const here = await requestJson('/run/where', {run, map: 'Route101'});
	assert.equal(here.status, 200);
	assert.equal(here.body.mons.find(mon => mon.species === 'Lillipup').owned, true);
	assert.equal(here.body.mons.find(mon => mon.species === 'Skitty').owned, false);

	const nowhere = await requestJson('/run/where', {run, map: 'Nowhere'});
	assert.equal(nowhere.status, 400);
	assert.equal(nowhere.body.code, 'UnknownMap');
});

test('learnable splits what a Pokemon can learn now from what is still ahead', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply', {run, command: RUN_CATCH})).body.run;
	const learn = await requestJson('/run/learnable', {run, id: 'mon-1'});
	assert.equal(learn.status, 200);
	assert.ok(learn.body.now.length > 0);
	assert.ok(learn.body.later.length > 0, 'a level 3 Lillipup has moves still ahead of it');
	for (const entry of learn.body.later) {
		assert.ok(entry.level > 3, 'a "later" move must actually be later');
	}
});

test('undo returns the run one command back', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply', {run, command: RUN_CATCH})).body.run;
	const undone = await requestJson('/run/undo', {run});
	assert.equal(undone.status, 200);
	assert.equal(undone.body.run.box.length, 0);
	assert.equal(undone.body.run.log.length, 0);

	const nothing = await requestJson('/run/undo', {run: undone.body.run});
	assert.equal(nothing.status, 400);
	assert.match(nothing.body.error, /nothing to undo/);
});

test('the map list is served without a run, and states its own limits', async () => {
	const response = await fetch(`${baseUrl}/run/maps`);
	assert.equal(response.status, 200);
	const body = await response.json();
	// 123 unique maps — the decomp's nine duplicate Altering Cave declarations
	// collapse to the one roster any lookup can reach.
	assert.equal(body.maps.length, 123);
	assert.ok(body.maps.every(map => map.name && map.map && map.methods.length));
	// Gifts, statics and trades have no wild table; a client offering this list
	// must be able to say so rather than implying it is every Pokemon in the game.
	assert.match(body.limits.note, /scripted events/);
});

test('the box matrix is served whole, and an unknown trainer is a 400', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply', {run, command: RUN_CATCH})).body.run;

	const matrix = await requestJson('/run/matrix', {run});
	assert.equal(matrix.status, 200);
	assert.equal(matrix.body.trainer, 'Youngster Calvin');
	assert.equal(matrix.body.order, 0);
	// The grid arrives whole. A client that had to fetch a cell at a time would
	// be back to asking one damage calculation per matchup, which is the thing
	// this endpoint exists to stop.
	assert.equal(matrix.body.grid.length, 3);
	for (const cell of matrix.body.grid) {
		assert.ok(cell.enemy.species && cell.enemy.level);
		assert.equal(cell.versus.length, 1);
		const row = cell.versus[0];
		assert.ok(['faster', 'slower', 'tie'].includes(row.speed));
		assert.ok(row.us.move && row.them.move, 'both directions or the cell is half a matchup');
	}
	// The projection travels with the grid: the panel has to be able to say "at
	// the cap you will legally have" rather than presenting raised levels as the
	// box the player is looking at.
	assert.deepEqual(matrix.body.projection, {applied: true, cap: 12, from: 'projected'});
	assert.deepEqual(matrix.body.box.map(entry => [entry.id, entry.from, entry.level]),
		[['mon-1', 3, 12]]);

	const named = await requestJson('/run/matrix', {run, trainer: 'Leader Brawly'});
	assert.equal(named.status, 200);
	assert.equal(named.body.projection.cap, 21);

	// A misnamed trainer is the caller's typo, so it comes back as a 400 with the
	// near-misses intact — the message is the feature, and a 500 would eat it.
	const unknown = await requestJson('/run/matrix', {run, trainer: 'Brawly'});
	assert.equal(unknown.status, 400);
	assert.equal(unknown.body.code, 'InvalidRunCommand');
	assert.match(unknown.body.error, /no fight named "Brawly".*did you mean: Leader Brawly/s);

	// An empty box is the caller's mistake, not a 500.
	const empty = await requestJson('/run/matrix', {run: await newRun()});
	assert.equal(empty.status, 400);
	assert.match(empty.body.error, /no Pokemon in the box to compare/);
});

test('the advisor answers over HTTP, and refuses with the reason', async () => {
	let run = await newRun();
	run = (await requestJson('/run/apply',
		{run, command: ownedCatch(
			{kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3})})).body.run;

	// An empty party is a refusal, not a 500: nothing has been chosen to improve.
	const noParty = await requestJson('/run/advise', {run});
	assert.equal(noParty.status, 400);
	assert.equal(noParty.body.code, 'InvalidRunCommand');
	assert.match(noParty.body.error, /the party is empty/);

	run = (await requestJson('/run/apply',
		{run, command: {kind: 'party', ids: ['mon-1']}})).body.run;

	const advice = await requestJson('/run/advise', {run});
	assert.equal(advice.status, 200);
	assert.equal(advice.body.trainer, 'Youngster Calvin');
	assert.equal(advice.body.order, 0);
	assert.ok(advice.body.considered > 0);
	// The same projection the board sends, because these are the board's numbers.
	assert.deepEqual(advice.body.projection, {applied: true, cap: 12, from: 'projected'});
	assert.deepEqual(advice.body.party, [{id: 'mon-1', species: 'Poochyena', nickname: null,
		level: 12, from: 3}]);
	// The shortlist arrives whole — ten one-line changes IS the answer.
	assert.ok(advice.body.upgrades.length > 0 && advice.body.upgrades.length <= 10);
	const top = advice.body.upgrades[0];
	assert.equal(top.kind, 'teach');
	assert.equal(top.id, 'mon-1');
	assert.equal(top.detail, 'Bite');
	assert.ok(advice.body.availability.undatedMovesExcluded > 0,
		'undated TM and tutor routes must not masquerade as early-game access');
	assert.deepEqual(Object.keys(top.delta).sort(), ['damage', 'koConceded', 'koGained']);
	assert.ok(top.delta.damage > 0, 'the reachable move must improve the board');

	// A misnamed trainer keeps its near-misses, like every other run endpoint.
	const unknown = await requestJson('/run/advise', {run, trainer: 'Brawly'});
	assert.equal(unknown.status, 400);
	assert.match(unknown.body.error, /no fight named "Brawly".*did you mean: Leader Brawly/s);

	// And a Heart Scale spent over HTTP comes back in the run, out of the bag.
	const held = (await requestJson('/run/apply',
		{run, command: {kind: 'acquire', item: 'Heart Scale'}})).body.run;
	const spent = await requestJson('/run/apply',
		{run: held, command: {kind: 'heartScale', id: 'mon-1', stat: 'spd'}});
	assert.equal(spent.status, 200);
	assert.deepEqual(spent.body.run.box[0].ivs, Object.assign({}, OWNED_IVS, {spd: 31}));
	assert.deepEqual(spent.body.run.bag, {});
	const empty = await requestJson('/run/apply',
		{run: spent.body.run, command: {kind: 'heartScale', id: 'mon-1', stat: 'spa'}});
	assert.equal(empty.status, 400);
	assert.match(empty.body.error, /need 1, the bag has 0/);
});

test('the recreation rides HTTP: a roll, a spend, and one played turn', async () => {
	const runtime = require('../lib/run');
	let run = runtime.createRun({name: 'HTTP recreation', now: 't0',
		permadeath: true});

	// The die rolls off the real table, and what it rolls is catchable as-is.
	// The roll authors the whole identity — the client only carries it.
	const rolled = await requestJson('/run/encounter', {run, map: 'Route101'});
	assert.equal(rolled.status, 200);
	assert.ok(rolled.body.roll.species && rolled.body.roll.level >= 1);
	assert.ok(rolled.body.roll.nature, 'the roll authors a nature');
	assert.ok(rolled.body.roll.ability, 'the roll authors an ability');
	const caught = await requestJson('/run/apply', {run, command: {
		kind: 'catch', species: rolled.body.roll.species,
		level: rolled.body.roll.level, map: 'Route101', method: rolled.body.roll.method,
		ivs: rolled.body.roll.ivs, nature: rolled.body.roll.nature,
		ability: rolled.body.roll.ability,
	}});
	assert.equal(caught.status, 200);
	const kept = caught.body.run.box.find(mon => mon.species === rolled.body.roll.species);
	assert.equal(kept.nature, rolled.body.roll.nature,
		'the caught mon owns the nature the roll authored');
	assert.equal(kept.ability, rolled.body.roll.ability,
		'the caught mon owns the ability the roll authored');
	run = caught.body.run;

	// The same die serves scripted events: advice until a catch writes it.
	const authored = await requestJson('/run/identity', {species: 'Torchic'});
	assert.equal(authored.status, 200);
	assert.deepEqual(Object.keys(authored.body.identity.ivs).sort(),
		['atk', 'def', 'hp', 'spa', 'spd', 'spe']);
	assert.ok(authored.body.identity.nature && authored.body.identity.ability);
	const nameless = await requestJson('/run/identity', {});
	assert.equal(nameless.status, 400);
	assert.match(nameless.body.error, /species is required/);

	// A used route refuses the die with the rule's own words.
	const again = await requestJson('/run/encounter', {run, map: 'Route101'});
	assert.equal(again.status, 400);
	assert.match(again.body.error, /roll: Route101 already gave its encounter/);

	// Spend is a command like any other, and spent means spent.
	const fled = await requestJson('/run/apply',
		{run, command: {kind: 'spend', map: 'Route102', reason: 'it got away'}});
	assert.equal(fled.status, 200);
	assert.match(fled.body.summary, /Route102 spent — it got away; nothing kept/);

	// One battle turn over the wire: start names the run's next fight, act
	// resolves a chosen move, and the whole bundle rides the payloads.
	run = (await requestJson('/run/apply',
		{run, command: {kind: 'party', ids: ['mon-1']}})).body.run;
	const started = await requestJson('/run/battle/start', {run, seed: 42});
	assert.equal(started.status, 200);
	assert.equal(started.body.battle.trainer, 'Youngster Calvin');
	const move = started.body.actions.find(action => action.kind === 'move');
	assert.ok(move, 'the opening offers a move');
	const acted = await requestJson('/run/battle/act',
		{battle: started.body.battle, action: {kind: 'move', move: move.move}});
	assert.equal(acted.status, 200);
	assert.ok(acted.body.events.length > 0, 'a turn narrates itself');
	assert.equal(acted.body.battle.step, 1);

	// And a battle refusal is a 400 with the reason, not a 500.
	const bad = await requestJson('/run/battle/act',
		{battle: started.body.battle, action: {kind: 'move', move: 'Earthquake'}});
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /battle: "Earthquake" is not usable right now/);
});

test('a wild fight rides HTTP: rolled, fought, the ball thrown, forgeries refused', async () => {
	const runtime = require('../lib/run');
	let run = runtime.createRun({name: 'wild HTTP', now: 't0', permadeath: true});
	run = runtime.applyAll(run, [
		ownedCatch({kind: 'catch', species: 'Starly', map: 'Route102', level: 5}),
		{kind: 'party', ids: ['mon-1']},
	]);

	const rolled = await requestJson('/run/encounter', {run, map: 'Route101'});
	assert.equal(rolled.status, 200);
	const started = await requestJson('/run/battle/wild',
		{run, roll: rolled.body.roll, seed: 7});
	assert.equal(started.status, 200);
	assert.match(started.body.battle.trainer, /^Wild /);
	const ball = started.body.actions.find(action => action.kind === 'ball');
	assert.ok(ball && ball.chance >= 0, 'the ball comes priced over the wire');

	const thrown = await requestJson('/run/battle/act',
		{battle: started.body.battle, action: {kind: 'ball'}});
	assert.equal(thrown.status, 200);
	assert.match(thrown.body.events.map(event => event.text).join(' '),
		/You threw a Poke Ball!/);

	// A roll the route cannot produce is refused with the table's own words.
	const forged = await requestJson('/run/battle/wild',
		{run, roll: {map: 'Route101', species: 'Rayquaza', level: 5}});
	assert.equal(forged.status, 400);
	assert.match(forged.body.error, /is not on Route101's table/);
	const missing = await requestJson('/run/battle/wild', {run});
	assert.equal(missing.status, 400);
	assert.match(missing.body.error, /send what \/run\/encounter rolled/);
});

test('the wire refuses garbage where the engine would crash: bundles, runs, knobs', async () => {
	const runtime = require('../lib/run');
	let run = runtime.createRun({name: 'hardened', now: 't0', permadeath: true});
	run = runtime.applyAll(run, [
		ownedCatch({kind: 'catch', species: 'Poochyena', map: 'Route101', level: 3}),
		{kind: 'party', ids: ['mon-1']},
	]);

	// A hand-edited battle bundle is a 400 that names the fix, never a 500.
	const gutted = await requestJson('/run/battle/act',
		{battle: {state: {}}, action: {kind: 'move', move: 'Tackle'}});
	assert.equal(gutted.status, 400);
	assert.match(gutted.body.error, /send the bundle unaltered/);
	const missing = await requestJson('/run/battle/act',
		{action: {kind: 'move', move: 'Tackle'}});
	assert.equal(missing.status, 400);
	assert.match(missing.body.error, /send the bundle from \/run\/battle\/start/);

	// The die and the driver check the run's shape like every other endpoint.
	for (const route of ['/run/encounter', '/run/battle/start']) {
		const forged = await requestJson(route, {run: {version: run.version}});
		assert.equal(forged.status, 400, `${route} must refuse a version-only run`);
	}

	// The ranker's knobs pass through bounded: a played top candidate on
	// demand, the grid alone at zero, and out-of-range refused by name.
	const played = await requestJson('/run/rank',
		{run, trainer: 'Youngster Calvin', rollouts: 2, adjudicate: 1});
	assert.equal(played.status, 200);
	assert.equal(played.body.parties[0].adjudication.rollouts, 2);
	const gridOnly = await requestJson('/run/rank',
		{run, trainer: 'Youngster Calvin', rollouts: 0});
	assert.equal(gridOnly.status, 200);
	assert.equal(gridOnly.body.adjudication, null);
	const greedy = await requestJson('/run/rank', {run, rollouts: 4900});
	assert.equal(greedy.status, 400);
	assert.match(greedy.body.error, /rollouts must be an integer from 0 to 48/);

	// The playbook rides the wire with the same bounded knob, and refuses a
	// party-less run with the CLI's own words.
	const partied = runtime.applyAll(run, []);
	const booked = await requestJson('/run/playbook',
		{run: partied, trainer: 'Youngster Calvin', rollouts: 2});
	assert.equal(booked.status, 200);
	assert.equal(booked.body.odds.rollouts, 2);
	assert.ok(booked.body.assignments.length > 0);
	assert.ok(booked.body.line.events.length > 0);
	const bookless = await requestJson('/run/playbook',
		{run: Object.assign({}, run, {party: []}), trainer: 'Youngster Calvin'});
	assert.equal(bookless.status, 400);
	assert.match(bookless.body.error, /set a party first/);
	const bookGreedy = await requestJson('/run/playbook', {run, rollouts: 4900});
	assert.equal(bookGreedy.status, 400);

	// The split sheet plays its boss on the same bounded knob.
	const sheet = await requestJson('/run/split', {run, rollouts: 2});
	assert.equal(sheet.status, 200);
	assert.equal(sheet.body.adjudication.rollouts, 2);
	assert.equal(sheet.body.adjudication.trainer, sheet.body.split.boss);
	const unplayed = await requestJson('/run/split', {run});
	assert.equal(unplayed.body.adjudication, null, 'unasked, the sheet stays a grid');
	const splitGreedy = await requestJson('/run/split', {run, rollouts: 4900});
	assert.equal(splitGreedy.status, 400);
});
