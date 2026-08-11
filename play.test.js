/* eslint-env node, es6 */
'use strict';

/**
 * Gate for the `play` CLI.
 *
 * `run.test.js` covers the rules. What is only checkable here is the save file:
 * that a run survives the round trip to disk and back, that a read-only
 * subcommand really does not write, and that a failed command leaves the file
 * exactly as it was.
 *
 * That last one is the reason this file exists. `run.apply` is pure, so a
 * refusal cannot corrupt a run in memory — but a CLI that wrote before checking,
 * or wrote a partial document, would lose a playthrough, and no test of the pure
 * layer would notice.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const play = require('./play');

let dir;
let file;
let output;
let errors;

test.beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runbun-play-'));
	file = path.join(dir, 'run.json');
	output = [];
	errors = [];
});

test.afterEach(() => {
	fs.rmSync(dir, {recursive: true, force: true});
});

/** Run a subcommand the way the CLI would, capturing what it printed. */
function cli(...argv) {
	const log = console.log;
	const error = console.error;
	console.log = (...args) => output.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));
	try {
		play.main([...argv, '--file', file]);
	} finally {
		console.log = log;
		console.error = error;
	}
	return output[output.length - 1] || '';
}

function read() {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('a run round-trips through the save file unchanged', () => {
	cli('new', '--name', 'Round Trip');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	const onDisk = read();
	assert.equal(onDisk.name, 'Round Trip');
	assert.equal(onDisk.box.length, 1);
	assert.equal(onDisk.box[0].origin.mapName, 'Route101');
	// The file is the record, so it has to be readable by a human as well as by
	// the next invocation.
	assert.match(fs.readFileSync(file, 'utf8'), /^\{\n\t"version"/);
});

test('a refused command leaves the save file untouched', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	const before = fs.readFileSync(file, 'utf8');

	assert.throws(() => cli('catch', 'Ralts', '--map', 'Route101', '--level', '3'),
		/does not appear on Route101/);
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refusal must not write');

	assert.throws(() => cli('teach', 'mon-1', 'Dragon Dance'), /cannot learn Dragon Dance/);
	assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('read-only subcommands do not write', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	cli('party', 'mon-1');
	const before = fs.readFileSync(file, 'utf8');
	for (const command of [['status'], ['where', 'Route101'], ['find', 'Feebas'],
		['learn', 'mon-1'], ['next'], ['plan'], ['log'], ['box']]) {
		cli(...command);
		assert.equal(fs.readFileSync(file, 'utf8'), before, `${command[0]} wrote to the save`);
	}
});

test('new refuses to clobber an existing run without being told to', () => {
	cli('new', '--name', 'First');
	assert.throws(() => cli('new', '--name', 'Second'), /already exists; pass --force/);
	assert.equal(read().name, 'First');
	cli('new', '--name', 'Second', '--force');
	assert.equal(read().name, 'Second');
});

test('a missing save file says how to start one', () => {
	assert.throws(() => cli('status'), /no run at .*; start one with: node play\.js new/);
});

test('the level cap is opt-in at creation', () => {
	cli('new');
	assert.equal(read().rules.levelCap, 'none');
	cli('new', '--force', '--cap', '--nuzlocke');
	assert.equal(read().rules.levelCap, 'next-milestone-ace');
	assert.equal(read().rules.permadeath, true);
});

test('status renders the party in order, then the box', () => {
	cli('new', '--cap');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3', '--name', 'Scout');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	cli('catch', 'Skitty', '--map', 'Route101', '--level', '2');
	cli('party', 'mon-3', 'mon-1');

	const status = cli('status');
	assert.match(status, /next: #0 Youngster Calvin/);
	assert.match(status, /split 1 \/ 18 — Leader Brawly/);
	assert.match(status, /level cap: 12 \(Team Aqua Grunt Petalburg Woods's/);
	// Nicknames are the point of a box feeling like yours.
	assert.match(status, /Scout the Lillipup L3/);
	// Party first and in party order, then everything else.
	assert.ok(status.indexOf('mon-3') < status.indexOf('mon-1'), 'party order should lead');
	assert.ok(status.indexOf('mon-1') < status.indexOf('mon-2'), 'boxed mons come after');
	assert.match(status, /party 1/);
	assert.match(status, /box/);
	// Where each one came from travels with it.
	assert.match(status, /walk · Route101/);
});

test('where lists a map, marking what the run already owns', () => {
	cli('new');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	const listing = cli('where', 'Route101');
	assert.match(listing, /Route101 \(MAP_ROUTE101\)/);
	assert.match(listing, /✓ Poochyena/);
	assert.match(listing, / {2}Lillipup/);
	// A wrong map name is the likeliest mistake, so it suggests rather than just
	// refusing.
	assert.throws(() => cli('where', 'Route 1O1'), /no map named/);
	assert.throws(() => cli('where', 'Route11'), /did you mean: .*Route11/);
});

test('find is the inverse of where, and says when a species is scripted', () => {
	cli('new');
	const feebas = cli('find', 'Feebas');
	assert.match(feebas, /Super Rod/);
	// Castform is the Weather Institute gift and appears in no wild table.
	assert.match(cli('find', 'Castform'), /Gifts, statics, trades and starters are scripted/);
});

test('learn separates what it can learn now from what is still ahead', () => {
	cli('new');
	cli('catch', 'Mudkip', '--level', '5');
	const learn = cli('learn', 'mon-1');
	assert.match(learn, /^now \(\d+\):/m);
	assert.match(learn, /^later \(\d+\):/m);
	assert.match(learn, /@\d+/, 'a not-yet move should carry the level it arrives at');
});

test('plan runs the whole stack from the save file', () => {
	cli('new');
	cli('catch', 'Mudkip', '--level', '5');
	cli('party', 'mon-1');
	const plan = cli('plan');
	assert.match(plan, /Youngster Calvin \(#0\)/);
	assert.match(plan, /decided by|contested by|only one action/);
	// A named trainer overrides the run's position, for looking ahead.
	assert.match(cli('plan', 'Leader Brawly'), /Leader Brawly/);
});

test('undo rewinds the save file', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	cli('beat', 'Youngster Calvin');
	assert.equal(read().position, 0);
	const message = cli('undo');
	assert.match(message, /undid: beat Youngster Calvin/);
	assert.equal(read().position, -1);
	assert.equal(read().box.length, 1, 'undo must not rewind further than one command');
});

test('an unknown subcommand prints the usage rather than a stack trace', () => {
	cli('new');
	assert.throws(() => cli('yeet', 'mon-1'), /unknown command "yeet"/);
	assert.throws(() => cli('yeet', 'mon-1'), /node play\.js <command>/);
});

test('flags and positionals are told apart, including multi-word values', () => {
	const parsed = play.parseArgs(['Sitrus', 'Berry', '--count', '3', '--force']);
	assert.deepEqual(parsed.positional, ['Sitrus', 'Berry']);
	assert.deepEqual(parsed.flags, {count: '3', force: true});
	// A flag with no value, immediately before another flag, must not swallow it.
	const trailing = play.parseArgs(['--cap', '--name', 'Nuzlocke']);
	assert.deepEqual(trailing.flags, {cap: true, name: 'Nuzlocke'});
});

test('items move between bag and holder through the CLI', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	cli('acquire', 'Sitrus Berry', '--count', '2');
	assert.deepEqual(read().bag, {'Sitrus Berry': 2});
	cli('give', 'mon-1', 'Sitrus', 'Berry');
	assert.equal(read().box[0].item, 'Sitrus Berry');
	assert.deepEqual(read().bag, {'Sitrus Berry': 1});
	cli('take', 'mon-1');
	assert.deepEqual(read().bag, {'Sitrus Berry': 2});
});

test('milestones prints the spine without writing', () => {
	cli('new');
	cli('beat', 'Leader', 'Brawly');
	const before = fs.readFileSync(file, 'utf8');
	const spine = cli('milestones');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'milestones wrote to the save');
	assert.match(spine, /1 \/ 34 milestones/);
	assert.match(spine, /✓ # {2}77 {2}Leader Brawly/);
	assert.match(spine, /· # 139 {2}Leader Roxanne/);
});
