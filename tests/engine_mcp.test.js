/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the engine MCP server (scripts/engine-mcp.js): the JSON-RPC
 * surface and the tools an agent plans a hard fight with.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const mcp = require('../scripts/engine-mcp.js');

function call(name, args) {
	let out = null;
	const write = process.stdout.write;
	process.stdout.write = chunk => { out = JSON.parse(chunk); return true; };
	try {
		mcp.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
	} finally {
		process.stdout.write = write;
	}
	return out.result;
}

function rpc(message) {
	let out = null;
	const write = process.stdout.write;
	process.stdout.write = chunk => { out = JSON.parse(chunk); return true; };
	try {
		mcp.handle(message);
	} finally {
		process.stdout.write = write;
	}
	return out;
}

test('the server speaks MCP: initialize, tools/list, unknown methods refused', () => {
	assert.equal(rpc({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}).result.serverInfo.name, 'runbun-engine');
	const names = rpc({jsonrpc: '2.0', id: 2, method: 'tools/list'}).result.tools.map(tool => tool.name);
	for (const name of ['fight_info', 'availability', 'new_box', 'matchup', 'start_fight', 'act', 'evaluate']) {
		assert.ok(names.includes(name), name);
	}
	assert.equal(rpc({jsonrpc: '2.0', id: 3, method: 'nope'}).error.code, -32601);
	assert.equal(call('no_such_tool', {}), undefined);
});

test('an agent can read a wall, find its answers, build a box and play it', () => {
	const info = JSON.parse(call('fight_info', {trainer: 'Leader Norman'}).content[0].text);
	assert.equal(info.team.length, 6);
	assert.ok(info.team.some(mon => mon.ability === 'Huge Power'));
	const where = JSON.parse(call('availability', {species: 'Cufant', before: 'Leader Norman'}).content[0].text);
	assert.ok(where.routes.some(route => route.openBefore), 'Cufant is catchable before Norman');
	const built = JSON.parse(call('new_box', {trainer: 'Leader Norman', members: [
		{species: 'Copperajah'}, {species: 'Aggron'}, {species: 'Crustle'}]}).content[0].text);
	assert.equal(built.cap, 42);
	assert.ok(built.box.every(mon => mon.level === 42));
	const opened = JSON.parse(call('start_fight', {box: built.id, trainer: 'Leader Norman', seed: 1}).content[0].text);
	assert.ok(opened.actions.some(action => action.kind === 'move'));
	const move = opened.actions.find(action => action.kind === 'move').move;
	const next = JSON.parse(call('act', {fight: opened.id, action: {kind: 'move', move}}).content[0].text);
	assert.ok(next.turn >= opened.turn);
	const refused = call('act', {fight: 'fight-none', action: {kind: 'move', move}});
	assert.equal(refused.isError, true);
});
