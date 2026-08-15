/* eslint-env node, es6 */
'use strict';

/**
 * Project canonical runtime evidence into the current run document. The
 * contract registry owns vocabulary and envelope validation; this adapter owns
 * only the projection into commands that run.js can currently represent.
 */

const runtime = require('./run');
const contract = require('./src/js/runtime_contract');

const SCHEMA_VERSION = contract.SCHEMA_VERSION;

function fail(message) {
	const error = new Error(`game runtime event: ${message}`);
	error.code = 'InvalidGameRuntimeEvent';
	error.statusCode = 400;
	throw error;
}

function validateEvent(event, previousRevision) {
	try {
		contract.validateEvent(event);
	} catch (error) {
		fail(error.message.replace(/^runtime contract: /, ''));
	}
	const revision = event.revision !== undefined ? event.revision : event.sourceSequence;
	if (previousRevision !== null && revision <= previousRevision) {
		fail(`revision ${revision} follows ${previousRevision}; events must be strictly ordered`);
	}
	return revision;
}

function record(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function captureFromPayload(payload) {
	const capture = payload.capture || payload;
	record(capture, 'pokemon.caught payload.capture');
	if (typeof capture.species !== 'string' || !capture.species) {
		fail('pokemon.caught payload.capture.species is required');
	}
	return {
		kind: 'catch',
		species: capture.species,
		...(capture.map || payload.map ? {map: capture.map || payload.map} : {}),
		...(capture.level !== undefined ? {level: capture.level} : {}),
		...(capture.method ? {method: capture.method} : {}),
		...(capture.nickname ? {nickname: capture.nickname} : {}),
		...(capture.shiny !== undefined ? {shiny: !!capture.shiny} : {}),
		...(capture.ivs ? {ivs: capture.ivs} : {}),
	};
}

function eventCommands(event) {
	// Public callers historically passed v1 evidence directly. Keep that seam
	// explicit and narrow: only the normalizer may translate old vocabulary.
	const canonical = event.schemaVersion === SCHEMA_VERSION ? event :
		contract.normalizeEvent(event);
	if (canonical === event) contract.validateEvent(canonical);
	event = canonical;
	const payload = event.payload;
	switch (event.kind) {
	case 'party.changed': {
		if (!Array.isArray(payload.partyInstanceIds) ||
			payload.partyInstanceIds.some(id => typeof id !== 'string' || !id)) {
			fail('party.changed payload.partyInstanceIds must be an array of instance IDs');
		}
		const fainted = payload.faintedInstanceIds || [];
		if (!Array.isArray(fainted) || fainted.some(id => typeof id !== 'string' || !id)) {
			fail('party.changed payload.faintedInstanceIds must be an array of instance IDs');
		}
		return fainted.map(id => ({kind: 'faint', id, of: payload.faintedBy || 'observed battle'}))
			.concat([{kind: 'party', ids: payload.partyInstanceIds}]);
	}
	case 'pokemon.fainted': {
		const id = payload.instanceId || payload.id;
		if (typeof id !== 'string' || !id) fail('pokemon.fainted payload.instanceId is required');
		return [{kind: 'faint', id,
			...(payload.to ? {to: payload.to} : {}),
			...(payload.move ? {move: payload.move} : {}),
			...(payload.of ? {of: payload.of} : {}),
		}];
	}
	case 'bag.changed':
		if (typeof payload.item !== 'string' || !payload.item) {
			fail('bag.changed payload.item is required');
		}
		if (!Number.isInteger(payload.delta)) fail('bag.changed payload.delta must be an integer');
		if (payload.delta === 0) return [];
		return [{kind: payload.delta > 0 ? 'acquire' : 'use', item: payload.item,
			count: Math.abs(payload.delta)}];
	case 'pokemon.caught':
		return [captureFromPayload(payload)];
	case 'battle.ended':
		if (payload.outcome === 'won' && payload.trainer) {
			return [{kind: 'beat', trainer: payload.trainer}];
		}
		return [];
	default:
		return [];
	}
}

function evidenceView(event, revision) {
	return {
		eventId: event.eventId,
		attemptId: event.attemptId,
		profileId: event.profileId,
		revision,
		kind: event.kind,
		source: event.source,
		observedAt: event.observedAt,
		payload: event.payload,
		...(event.compatibility ? {compatibility: event.compatibility} : {}),
	};
}

function project(events, options) {
	if (!Array.isArray(events) || !events.length) fail('events must be a non-empty array');
	const opts = options || {};
	let state = opts.initialRun || null;
	let previousRevision = null;
	let attemptId = null;
	let profileId = null;
	let ended = false;
	const applied = [];
	const observedOnly = [];
	const evidence = [];
	const ledger = [];
	let outcome = null;

	for (const input of events) {
		let event;
		try {
			event = contract.normalizeEvent(input);
		} catch (error) {
			fail(error.message.replace(/^runtime contract: /, ''));
		}
		const revision = validateEvent(event, previousRevision);
		if (attemptId !== null && event.attemptId !== attemptId) {
			fail('one replay cannot contain multiple attemptIds');
		}
		if (profileId !== null && event.profileId !== profileId) {
			fail('one replay cannot contain multiple profileIds');
		}
		if (ended) fail('events cannot follow run.ended');
		attemptId = event.attemptId;
		profileId = event.profileId;
		previousRevision = revision;
		evidence.push(event);

		if (event.kind === 'run.started') {
			if (state) fail('run.started cannot appear after a run already exists');
			const payload = event.payload;
			state = runtime.createRun({
				attemptId: event.attemptId,
				profileId: event.profileId,
				name: payload.name || 'Runtime-synced run',
				now: event.observedAt,
				levelCap: payload.levelCap,
				permadeath: payload.permadeath,
				onePerRoute: payload.onePerRoute,
				dupesClause: payload.dupesClause,
				shinyClause: payload.shinyClause,
				routeUnit: payload.routeUnit,
				rival: payload.rival,
			});
			ledger.push({event, run: state, command: null});
			continue;
		}
		if (!state) fail('the first replay event must be run.started unless initialRun is supplied');

		if (event.kind === 'run.ended') {
			if (typeof event.payload.outcome !== 'string' || !event.payload.outcome) {
				fail('run.ended payload.outcome is required');
			}
			outcome = {
				status: event.payload.outcome,
				eventId: event.eventId,
				attemptId: event.attemptId,
				profileId: event.profileId,
				revision,
				source: event.source,
				observedAt: event.observedAt,
				payload: event.payload,
			};
			ledger.push({event, run: state, command: null});
			ended = true;
			continue;
		}

		const commands = eventCommands(event);
		ledger.push({event, run: state, command: null});
		if (!commands.length) {
			observedOnly.push(Object.assign(evidenceView(event, revision), {reason: 'not-projectable'}));
			continue;
		}
		for (const command of commands) {
			state = runtime.apply(state, command, {now: event.observedAt});
			ledger.push({event, run: state, command});
			applied.push(Object.assign(evidenceView(event, revision), {command}));
		}
	}

	return {
		run: state,
		cursor: {
			attemptId,
			profileId,
			revision: previousRevision,
			// Compatibility read for callers that used the v1 sequence name.
			sequence: previousRevision,
			schemaVersion: SCHEMA_VERSION,
		},
		evidence,
		applied,
		observedOnly,
		outcome,
		ledger,
	};
}

function replay(events, options) {
	const projected = project(events, options);
	const result = Object.assign({}, projected);
	delete result.ledger;
	return result;
}

async function persist(store, events, options) {
	if (!store || typeof store.commit !== 'function') fail('persist requires an attempt store');
	const projected = project(events, options);
	let expectedRevision = options && Number.isInteger(options.expectedRevision) ?
		options.expectedRevision : 0;
	const receipts = [];
	const projectionCounts = {};
	for (const row of projected.ledger) {
		let event = row.event;
		let commandId = event.eventId;
		if (row.command) {
			const index = projectionCounts[event.eventId] || 0;
			projectionCounts[event.eventId] = index + 1;
			commandId = event.eventId + ':projection:' + index;
			event = {
				schemaVersion: SCHEMA_VERSION,
				eventId: commandId,
				attemptId: row.event.attemptId,
				profileId: row.event.profileId,
				sourceSequence: row.event.revision !== undefined ?
					row.event.revision : row.event.sourceSequence,
				kind: 'command.applied',
				source: row.event.source,
				observedAt: row.event.observedAt,
				payload: {command: row.command, causedByEventId: row.event.eventId,
					causedByKind: row.event.kind},
			};
		}
		const receipt = await store.commit({
			run: row.run,
			expectedRevision,
			commandId,
			event,
		});
		expectedRevision = receipt.revision;
		receipts.push(receipt);
	}
	return Object.assign({}, projected, {
		receipts,
		head: receipts.length ? {
			attemptId: projected.cursor.attemptId,
			revision: receipts[receipts.length - 1].revision,
			run: projected.run,
			stateHash: receipts[receipts.length - 1].stateHash,
		} : null,
	});
}

module.exports = {
	SCHEMA_VERSION,
	EVENT_KINDS: contract.EVENT_KINDS,
	SOURCE_KINDS: contract.SOURCE_KINDS,
	validateEvent: contract.validateEvent,
	normalizeEvent: contract.normalizeEvent,
	eventCommands,
	project,
	replay,
	persist,
};
