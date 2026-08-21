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

const play = require('../lib/play');

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

test('the preset survives a single override, and --shiny takes on/off', () => {
	// --nuzlocke --permadeath off is the table minus permadeath, not no rules:
	// the other three fallbacks chase the PRESET flag, not resolved permadeath.
	cli('new', '--name', 'Overridden', '--nuzlocke', '--permadeath', 'off');
	let onDisk = read();
	assert.equal(onDisk.rules.permadeath, false);
	assert.equal(onDisk.rules.onePerRoute, true);
	assert.equal(onDisk.rules.dupesClause, 'line');
	assert.equal(onDisk.rules.shinyClause, true);

	// --shiny on means the same as bare --shiny; the sibling rule flags taught
	// the on/off convention and this one must not silently drop it.
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3', '--shiny', 'on');
	onDisk = read();
	assert.equal(onDisk.box[0].shiny, true);
});

test('rank is read-only and renders the shortlist with its lead', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	const before = fs.readFileSync(file, 'utf8');
	const ranked = cli('rank');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'rank must not write');
	assert.match(ranked, /Youngster Calvin \(#0\)/);
	assert.match(ranked, /\[\w+\]/, 'the lead is bracketed');
	assert.match(ranked, /assumes free switches/);
});

test('scout is read-only and grades open routes against the boss', () => {
	cli('new');
	const before = fs.readFileSync(file, 'utf8');
	const scouted = cli('scout');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'scout must not write');
	assert.match(scouted, /vs Leader Brawly \(#77\) at cap 21/);
	assert.match(scouted, /routes open/);
	assert.match(scouted, /wait on an HM/);
	assert.doesNotMatch(scouted, / surf\b/, 'no surf prospects before Surf');
});

test('the caps are the game\'s: on by default, --no-cap is the escape hatch', () => {
	cli('new');
	assert.equal(read().rules.levelCap, 'next-milestone-ace');
	cli('new', '--force', '--no-cap', '--nuzlocke');
	assert.equal(read().rules.levelCap, 'none');
	// Permadeath stays opt-in — that one IS a player rule, not a game mechanic.
	assert.equal(read().rules.permadeath, true);
});

test('status renders the party in order, then the box', () => {
	cli('new');
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
	assert.match(spine, /1 \/ 44 milestones/);
	assert.match(spine, /✓ # {2}77 {2}Leader Brawly/);
	assert.match(spine, /· # 139 {2}Leader Roxanne/);
});

test('the rival is declared at creation and stored', () => {
	cli('new', '--rival', 'Swampert');
	assert.equal(read().rules.rival, 'Swampert');
	assert.throws(() => cli('beat', 'Trainer', 'Rival', 'Cycling', 'Road', 'Sceptile'),
		/faces the Swampert rival/);
});

test('every subcommand appears in the usage text', () => {
	// The contract that would have caught the missing 'box': a verb that exists
	// but is not in the help is a verb nobody finds.
	for (const name of Object.keys(play.SUBCOMMANDS)) {
		assert.match(play.USAGE, new RegExp(`(^|[\\s/])${name}([\\s/]|$)`, 'm'),
			`subcommand "${name}" missing from usage`);
	}
});

test('matrix renders the whole box against a trainer, both directions', () => {
	cli('new');
	cli('catch', 'Lillipup', '--map', 'Route101', '--level', '3', '--name', 'Scout');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	cli('party', 'mon-1');
	const before = fs.readFileSync(file, 'utf8');

	const grid = cli('matrix');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'matrix wrote to the save');

	assert.match(grid, /Youngster Calvin \(#0\)/);
	// The levels on screen are the ones the fight is actually fought at, said out
	// loud — a grid that silently raised them would look like the box.
	assert.match(grid, /box at the cap it is fought under: L12 \(projected\)/);
	// One block per opposing Pokemon, one row per box entry — including the one
	// not in the party, because "which six" is the question this answers.
	assert.match(grid, /^ {2}Poochyena L5$/m);
	assert.match(grid, /^ {2}Rookidee L6$/m);
	assert.match(grid, /mon-1\s+Scout the Lillipup L12/);
	assert.match(grid, /mon-2\s+Poochyena L12/);
	// Each row carries the arrow and both sides' answer.
	assert.match(grid, /^ {4}[><=] mon-1 .*Tackle \d+%.*Bite \d+%$/m);

	// A named trainer looks ahead, and a fight that can kill says so — the mark
	// is the difference between a plan and a gamble, so it must render.
	const brawly = cli('matrix', 'Leader', 'Brawly');
	assert.match(brawly, /Leader Brawly \(#77\)/);
	assert.match(brawly, /box at the cap it is fought under: L21/);
	assert.match(brawly, / KO\b/);
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'matrix wrote to the save');
});

test('heartscale spends from the bag and refuses with the reason', () => {
	cli('new');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3', '--iv-spe', '18');
	const caughtIvs = Object.assign({}, read().box[0].ivs);
	// The owned IV is known; the bag refusal comes first, so this is the
	// empty-bag path.
	assert.throws(() => cli('heartscale', 'mon-1', 'spe'),
		/no shop sells them — need 1, the bag has 0/);
	assert.deepEqual(read().bag, {});

	cli('acquire', 'Heart', 'Scale', '--count', '2');
	assert.equal(cli('heartscale', 'mon-1', 'spe'),
		'Poochyena Speed IV 18 → 31 (Heart Scale spent, 1 left)');
	assert.equal(read().box[0].ivs.spe, 31);
	assert.deepEqual(read().bag, {'Heart Scale': 1});

	// A second scale on the same stat buys nothing, and the save is untouched.
	const before = fs.readFileSync(file, 'utf8');
	assert.throws(() => cli('heartscale', 'mon-1', 'spe'),
		/already has a 31 Speed IV/);
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refusal must not write');

	cli('undo');
	assert.deepEqual(read().bag, {'Heart Scale': 2}, 'undo puts the scale back');
	assert.deepEqual(read().box[0].ivs, caughtIvs,
		'undo restores the encounter roll, including the entered Speed IV');
});

test('advise ranks single changes against a fight without writing', () => {
	cli('new');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	cli('party', 'mon-1');
	const before = fs.readFileSync(file, 'utf8');

	const advice = cli('advise');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'advise wrote to the save');
	assert.match(advice, /Youngster Calvin \(#0\) — \d+ single changes weighed/);
	assert.match(advice, /party at the cap it is fought under: L12/);
	// Poochyena knows only Tackle. Undated TM/tutor access is not treated as
	// available before Calvin, so the advisor leads with the level-up move Bite.
	assert.match(advice, /^ {2}mon-1 {3}Poochyena {5}teach {7}Bite.*\+\d+\.\d\d bars$/m);
});

test('the recreation verbs: a starter opens the run, a roll suggests, a spend burns', () => {
	// The starter is the game's own opening: the pick lands as an L5 gift and
	// fixes the rival, and the wrong name is refused with the real list.
	assert.throws(() => cli('new', '--starter', 'Pikachu'),
		/the starters are Turtwig, Chimchar, Piplup/);
	assert.throws(() => cli('new', '--starter', 'Turtwig', '--rival', 'Blaziken'),
		/Turtwig fixes the rival to Swampert/);
	assert.match(cli('new', '--starter', 'Piplup', '--nuzlocke'),
		/Piplup L5 is in the box; the rival runs Blaziken/);
	assert.equal(read().box[0].species, 'Piplup');
	assert.equal(read().rules.rival, 'Blaziken');

	// A roll is read-only dice: the save is untouched, and the two ways to
	// settle it come back paste-ready, carrying the run file.
	const before = fs.readFileSync(file, 'utf8');
	const rolled = cli('roll', 'Route101');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'a roll must not write');
	assert.match(rolled, /^A wild \S+ L\d+ appeared!/);
	assert.match(rolled, new RegExp(`keep it: {5}node play\\.js catch \\S+ --level \\d+ ` +
		`--map Route101 --file ${file}`));
	assert.match(rolled, new RegExp(`got away: {4}node play\\.js spend Route101 --file ${file}`));

	// Spend writes the route away, and the spent route refuses the next roll.
	assert.match(cli('spend', 'Route101', '--reason', 'it fled'),
		/Route101 spent — it fled; nothing kept/);
	assert.throws(() => cli('roll', 'Route101'),
		/roll: Route101 already gave its encounter — it was spent/);
});

test('adjudicate plays the fight and reports the floor without writing', () => {
	cli('new', '--starter', 'Chimchar');
	cli('party', 'mon-1');
	const before = fs.readFileSync(file, 'utf8');

	assert.throws(() => cli('adjudicate', '--rollouts', '0'),
		/--rollouts must be an integer from 1 to 100/);
	const report = cli('adjudicate', '--rollouts', '3');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'adjudicate must not write');
	assert.match(report, /Youngster Calvin \(#0\) — the current party, played 3 times/);
	assert.match(report, /P\(win\) \d+% {2}· {2}\d+\.\d deaths expected {2}· {2}deathless \d+%/);
	assert.match(report, /a lower bound, not a promise/);
});

test('split --rollouts pins the played floor to the sheet', () => {
	cli('new', '--starter', 'Turtwig');
	cli('party', 'mon-1');
	const plain = cli('split');
	assert.ok(!/played \d+ times/.test(plain), 'unasked, the sheet stays a grid');
	const played = cli('split', '--rollouts', '2');
	assert.match(played, /played 2 times: P\(win\) \d+%/);
	assert.match(played, /floor policy — a lower bound/);
	assert.throws(() => cli('split', '--rollouts', 'many'),
		/--rollouts must be an integer from 1 to 100/);
});

test('use consumes from the bag and refuses an empty shelf', () => {
	cli('new');
	cli('acquire', 'Great', 'Ball', '--count', '3');
	assert.equal(cli('use', 'Great', 'Ball', '--count', '2'), 'used 2 Great Balls (1 left)');
	assert.deepEqual(read().bag, {'Great Ball': 1});
	assert.equal(cli('use', 'Great', 'Ball'), 'used Great Ball (0 left)');
	assert.throws(() => cli('use', 'Great', 'Ball'),
		/use: need 1 Great Ball, the bag has 0/);
	cli('undo');
	assert.deepEqual(read().bag, {'Great Ball': 1}, 'undo restores the throw');
});

test('playbook is read-only and renders the whole plan: odds, assignments, the line', () => {
	cli('new', '--starter', 'Turtwig');
	cli('catch', 'Poochyena', '--map', 'Route101', '--level', '3');
	cli('party', 'mon-1', 'mon-2');
	const before = fs.readFileSync(file, 'utf8');
	const book = cli('playbook', '--rollouts', '3');
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'playbook must not write');
	assert.match(book, /Youngster Calvin \(#0\) — the playbook, played 3 times/);
	assert.match(book, /odds: P\(win\) \d+%/);
	assert.match(book, /endings: /);
	assert.match(book, /assignments — who answers whom:/);
	assert.match(book, /the expected line — seed \d+, (win|loss) in \d+ turns/);
	assert.match(book, /wants to battle!/);
	assert.match(book, /a lower bound, not a promise/);
	assert.throws(() => cli('playbook', '--rollouts', 'many'),
		/--rollouts must be an integer from 1 to 100/);
});
